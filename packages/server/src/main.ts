import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import { Context, Effect, ManagedRuntime } from "effect";
import { makeChatManager, type ChatManager } from "./chat-manager.js";
import { apiErrorStatus, applicationError, attemptOperation, HttpError } from "./errors.js";
import { createRpcApiRouter } from "./http-api.js";
import { makeMetadataLayer, Metadata } from "./metadata.js";
import { makePiSdk, makePiSdkService } from "./pi-sdk.js";
import {
  allowedRoots,
  parsePort,
  safeError,
  securityHeaders,
  validateRequest,
} from "./security.js";

async function createPidexServer() {
  const application = await createPidexApplication();
  const server = createServer((req, res) => void application.handleRequest(req, res));
  return {
    server,
    close: async () => {
      await application.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    manager: application.manager,
  };
}

export async function createPidexApplication() {
  const runtime = ManagedRuntime.make(makeMetadataLayer());
  let manager: ChatManager | undefined;
  try {
    const metadata = Context.get(await runtime.context(), Metadata);
    const pi = makePiSdkService(makePiSdk());
    const chatManager = makeChatManager(pi, metadata);
    manager = chatManager;
    const csrf = randomBytes(32).toString("base64url");
    const roots = await runtime.runPromise(allowedRoots());
    const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
    const webScriptHashes = inlineScriptHashes(path.join(webRoot, "index.html"));
    const apiRouter = await runtime.runPromise(
      createRpcApiRouter({ csrf, roots, metadata, manager: chatManager, pi }),
    );
    const apiHandler = new RPCHandler(apiRouter, {
      errorStatusMap: {
        ...COMMON_ERROR_STATUS_MAP,
        ...apiErrorStatus,
        csrf: 403,
        internal_error: 500,
      },
      plugins: [new RequestLimitHandlerPlugin({ maxBodySize: 64 * 1024 })],
    });
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      securityHeaders(res, webScriptHashes);
      try {
        await runtime.runPromise(validateRequest(req));
        const route = new URL(req.url ?? "/", "http://localhost").pathname;
        if (route === "/api/rpc/live/events") {
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("X-Accel-Buffering", "no");
        }
        const { matched } = await apiHandler.handle(req, res, {
          prefix: "/api/rpc",
          context: { req },
        });
        if (matched) return;
        if (route.startsWith("/api/"))
          throw HttpError.make({ status: 404, code: "not_found", message: "API route not found" });
        serveWebApp(res, route, webRoot);
      } catch (error) {
        if (res.headersSent) return res.end();
        const protocolError = error instanceof HttpError ? error : undefined;
        res.statusCode = protocolError?.status ?? 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: { code: protocolError?.code ?? "internal_error", message: safeError(error) },
          }),
        );
      }
    };
    let closed = false;
    return {
      handleRequest: handler,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await runtime.runPromise(chatManager.shutdown());
        } finally {
          await runtime.dispose();
        }
      },
      manager: chatManager,
    };
  } catch (error) {
    try {
      if (manager) await runtime.runPromise(manager.shutdown());
    } finally {
      await runtime.dispose();
    }
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
