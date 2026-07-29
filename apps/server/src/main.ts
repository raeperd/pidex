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
import { wsClientMessageSchema } from "@pidex/api";
import { Context, Effect } from "effect";
import { WebSocketServer, type RawData } from "ws";
import { Chats, makeApplicationRuntime } from "./app-runtime.js";
import { applicationError, attemptOperation, HttpError } from "./errors.js";
import { createRpcApiRouter } from "./http-api.js";
import {
  allowedRoots,
  parsePort,
  safeError,
  securityHeaders,
  validateRequest,
} from "./security.js";

export async function createPidexServer() {
  const application = await createPidexApplication();
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

export async function createPidexApplication() {
  const runtime = makeApplicationRuntime();
  try {
    const effectContext = await runtime.context();
    const manager = Context.get(effectContext, Chats);
    const csrf = await runtime.runPromise(
      attemptOperation("security.csrf", () => randomBytes(32).toString("base64url")),
    );
    const roots = await runtime.runPromise(allowedRoots());
    const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
    const webScriptHashes = inlineScriptHashes(path.join(webRoot, "index.html"));
    const apiRouter = await runtime.runPromise(createRpcApiRouter({ csrf, roots }));
    const apiHandler = new RPCHandler(apiRouter, {
      errorStatusMap: {
        ...COMMON_ERROR_STATUS_MAP,
        action_conflict: 409,
        csrf: 403,
        dialog_mismatch: 409,
        dialog_value_invalid: 400,
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
        await runtime.runPromise(validateRequest(req, false, csrf));
        const route = new URL(req.url ?? "/", "http://localhost").pathname;
        const { matched } = await runtime.runPromise(
          attemptOperation("orpc.handle", () =>
            apiHandler.handle(req, res, {
              prefix: "/api/rpc",
              context: { req, "effect/context": effectContext },
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
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/api/ws") return false;
      try {
        runtime.runSync(validateRequest(req, false, csrf));
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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
    const result = wsClientMessageSchema.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : undefined;
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
    const app = yield* Effect.acquireRelease(
      attemptOperation("server.create", createPidexServer),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  NodeRuntime.runMain(main, { disableErrorReporting: true });
