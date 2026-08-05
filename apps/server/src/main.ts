import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import { authSecretSchema, safeParse, wsClientMessageSchema } from "@pidex/api";
import { Context, Effect } from "effect";
import { WebSocketServer, type RawData } from "ws";
import { Auth, Chats, makeApplicationRuntime } from "./app-runtime.js";
import type { AuthenticatedSession } from "./auth.js";
import { applicationError, attemptOperation, HttpError } from "./errors.js";
import { createRpcApiRouter } from "./http-api.js";
import {
  allowedRoots,
  parsePort,
  safeError,
  securityHeaders,
  validateRequest,
} from "./security.js";

export interface PidexServerOptions {
  readonly desktopBootstrapCredential: string;
}

export async function createPidexServer(options: PidexServerOptions) {
  const application = await createPidexApplication(options);
  try {
    const server = createServer((req, res) => void application.handleRequest(req, res));
    server.on("upgrade", (req, socket, head) => {
      if (!application.handleUpgrade(req, socket, head)) rejectUpgrade(socket);
    });
    return {
      server,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await application.close();
      },
      manager: application.manager,
    };
  } catch (error) {
    await application.close();
    throw error;
  }
}

export async function createPidexApplication(options: PidexServerOptions) {
  const runtime = makeApplicationRuntime(options);
  try {
    const effectContext = await runtime.context();
    const auth = Context.get(effectContext, Auth);
    const manager = Context.get(effectContext, Chats);
    const roots = await runtime.runPromise(allowedRoots());
    const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
    const webScriptHashes = inlineScriptHashes(path.join(webRoot, "index.html"));
    const apiRouter = await runtime.runPromise(createRpcApiRouter({ roots }));
    const apiHandler = new RPCHandler(apiRouter, {
      errorStatusMap: {
        ...COMMON_ERROR_STATUS_MAP,
        action_conflict: 409,
        client_mismatch: 403,
        csrf: 403,
        dialog_mismatch: 409,
        dialog_value_invalid: 400,
        forbidden: 403,
        internal_error: 500,
        interrupted_run: 409,
        model_unavailable: 400,
        project_missing_from_worktree: 400,
        project_not_git: 400,
        project_outside_repository: 400,
        run_mismatch: 409,
        session_busy: 409,
        stale_revision: 409,
        validation: 400,
        workspace_forbidden: 403,
        workspace_missing: 404,
        workspace_not_directory: 400,
        workspace_not_managed_worktree: 400,
        worktree_branch_read_failed: 400,
        worktree_branch_remove_failed: 400,
        worktree_create_failed: 400,
        worktree_has_tasks: 409,
        worktree_remove_failed: 400,
      },
      plugins: [new RequestLimitHandlerPlugin({ maxBodySize: 64 * 1024 })],
    });

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      securityHeaders(res, webScriptHashes);
      try {
        await runtime.runPromise(validateRequest(req));
        const route = new URL(req.url ?? "/", "http://localhost").pathname;
        let session: AuthenticatedSession | undefined;
        if (route === "/api/auth/desktop-grant") {
          if (req.method !== "POST")
            throw HttpError.make({
              status: 405,
              code: "method_not_allowed",
              message: "Method not allowed",
            });
          const authorization = req.headers.authorization;
          const bootstrapCredential = authorization?.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : "";
          const grant = await runtime
            .runPromise(auth.createDesktopGrant(bootstrapCredential))
            .catch(() => {
              throw unauthenticated();
            });
          json(res, 201, grant);
          return;
        }
        if (route === "/api/auth/desktop-session") {
          if (req.method !== "POST")
            throw HttpError.make({
              status: 405,
              code: "method_not_allowed",
              message: "Method not allowed",
            });
          const body = await readJsonBody(req);
          const parsed = safeParse(authSecretSchema, body);
          if (!parsed.success)
            throw HttpError.make({
              status: 400,
              code: "validation",
              message: "A grant secret is required",
            });
          const desktopSession = await runtime
            .runPromise(auth.exchangeDesktopGrant(parsed.output.secret))
            .catch(() => {
              throw unauthenticated();
            });
          res.statusCode = 204;
          res.setHeader(
            "Set-Cookie",
            `pidex_session=${desktopSession.credential}; HttpOnly; SameSite=Strict; Path=/`,
          );
          res.end();
          return;
        }
        if (route === "/api/auth/websocket-ticket") {
          if (req.method !== "POST")
            throw HttpError.make({
              status: 405,
              code: "method_not_allowed",
              message: "Method not allowed",
            });
          const credential = sessionCredential(req);
          if (!credential) throw unauthenticated();
          const authenticated = await runtime
            .runPromise(auth.authenticateSession(credential))
            .catch(() => {
              throw unauthenticated();
            });
          if (req.headers["x-pidex-csrf"] !== authenticated.csrfToken)
            throw HttpError.make({
              status: 403,
              code: "csrf",
              message: "Invalid CSRF token",
            });
          const ticket = await runtime.runPromise(auth.createWebSocketTicket(credential));
          json(res, 201, ticket);
          return;
        }
        if (route.startsWith("/api/rpc/") && route !== "/api/rpc/system/health") {
          const credential = sessionCredential(req);
          if (!credential)
            throw HttpError.make({
              status: 401,
              code: "unauthenticated",
              message: "Authentication required",
            });
          session = await runtime.runPromise(auth.authenticateSession(credential)).catch(() => {
            throw HttpError.make({
              status: 401,
              code: "unauthenticated",
              message: "Authentication required",
            });
          });
        }
        const { matched } = await runtime.runPromise(
          attemptOperation("orpc.handle", () =>
            apiHandler.handle(req, res, {
              prefix: "/api/rpc",
              context: { req, session, "effect/context": effectContext },
            }),
          ),
        );
        if (matched) return;
        if (route.startsWith("/api/"))
          await runtime.runPromise(
            Effect.fail(
              HttpError.make({ status: 404, code: "not_found", message: "API route not found" }),
            ),
          );
        await runtime.runPromise(
          attemptOperation("web.serve", () => serveWebApp(res, route, webRoot)),
        );
      } catch (error) {
        if (res.headersSent) return res.end();
        const protocolError = error instanceof HttpError ? error : undefined;
        json(res, protocolError?.status ?? 500, {
          error: { code: protocolError?.code ?? "internal_error", message: safeError(error) },
        });
      }
    };
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/api/ws") return false;
      try {
        runtime.runSync(validateRequest(req));
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      try {
        runtime.runSync(auth.consumeWebSocketTicket(requestUrl.searchParams.get("ticket") ?? ""));
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
      return true;
    };
    wss.on("connection", (socket) => {
      let connected = false;
      let alive = true;
      socket.on("message", (data) => {
        const message = parseClientMessage(data);
        if (!message) return socket.close(1008, "Invalid protocol message");
        if (!connected && message.type !== "hello") return socket.close(1008, "Hello required");
        if (message.type === "hello") {
          if (connected) return socket.close(1008, "Already connected");
          connected = true;
          void runtime
            .runPromise(
              Effect.gen(function* () {
                const chat = yield* manager.chat(message.chatId);
                yield* manager.connect(chat, socket, message.lastEventId);
              }),
            )
            .catch(() => socket.close(1008, "Chat not found"));
        } else if (message.type === "pong") alive = true;
      });
      const timer = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.send(JSON.stringify({ type: "ping" }));
      }, 20_000);
      socket.once("close", () => clearInterval(timer));
    });
    let closed = false;
    return {
      handleRequest: handler,
      handleUpgrade,
      close: async () => {
        if (closed) return;
        closed = true;
        for (const socket of wss.clients) socket.close(1001, "Server stopping");
        await runtime.dispose();
      },
      manager,
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

function inlineScriptHashes(indexFile: string) {
  if (!existsSync(indexFile)) return [];
  const html = readFileSync(indexFile, "utf8");
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script): script is string => Boolean(script))
    .map((script) => createHash("sha256").update(script).digest("base64"));
}

function serveWebApp(res: ServerResponse, route: string, webRoot: string) {
  if (!existsSync(webRoot))
    throw HttpError.make({
      status: 503,
      code: "web_build_missing",
      message: "Web build is missing; run pnpm build",
    });
  const requested = route === "/" ? "index.html" : route.slice(1);
  let file = path.resolve(webRoot, requested);
  if (!file.startsWith(`${webRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile())
    file = path.join(webRoot, "index.html");
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(file));
  res.setHeader(
    "Cache-Control",
    file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  );
  createReadStream(file).pipe(res);
}

function parseClientMessage(data: RawData) {
  try {
    const result = safeParse(wsClientMessageSchema, JSON.parse(data.toString()));
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

function contentTypeFor(file: string) {
  switch (path.extname(file).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sessionCredential(req: IncomingMessage) {
  const cookies = req.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "pidex_session") return value.join("=");
  }
  return undefined;
}

function unauthenticated() {
  return HttpError.make({
    status: 401,
    code: "unauthenticated",
    message: "Authentication required",
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024)
      throw HttpError.make({
        status: 413,
        code: "payload_too_large",
        message: "Request body is too large",
      });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw HttpError.make({
      status: 400,
      code: "validation",
      message: "Request body must be valid JSON",
    });
  }
}

function rejectUpgrade(socket: Duplex) {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

const main = Effect.scoped(
  Effect.gen(function* () {
    const port = yield* Effect.try({
      try: () => parsePort(),
      catch: (cause) => applicationError("server.port", cause),
    });
    const desktopBootstrapCredential = yield* Effect.try({
      try: () => readDesktopBootstrapCredential(),
      catch: (cause) => applicationError("auth.desktopBootstrap.read", cause),
    });
    const app = yield* Effect.acquireRelease(
      attemptOperation("server.create", () => createPidexServer({ desktopBootstrapCredential })),
      (server) =>
        Effect.promise(() =>
          server.close().catch((error) => {
            console.error(`Pidex shutdown failed: ${safeError(error)}`);
          }),
        ),
    );
    yield* listen(app.server, port);
    yield* Effect.logInfo(`Pidex ready at http://127.0.0.1:${port}`);
    return yield* Effect.never;
  }),
).pipe(
  Effect.tapError((error) =>
    Effect.sync(() => console.error(`Pidex cannot start: ${safeError(error)}`)),
  ),
);

function listen(server: ReturnType<typeof createServer>, port: number) {
  return attemptOperation(
    "server.listen",
    () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      }),
  );
}

function readDesktopBootstrapCredential() {
  if (process.env.PIDEX_ALLOW_ENV_BOOTSTRAP === "1") {
    const injected = process.env.PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL;
    if (!injected || injected.length < 32)
      throw new Error("Injected desktop bootstrap credential is missing");
    return injected;
  }
  if (process.env.PIDEX_DESKTOP_SUPERVISED !== "1") return randomBytes(32).toString("base64url");
  const credential = readFileSync(3, "utf8").trim();
  if (credential.length < 32) throw new Error("Desktop bootstrap credential is missing");
  return credential;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  NodeRuntime.runMain(main, { disableErrorReporting: true });
