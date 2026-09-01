import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import { Effect, Exit, FileSystem, Layer, Scope } from "effect";
import {
  HttpEffect,
  HttpServer,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { makeChatManager } from "./chat-manager.js";
import { apiErrorStatus, HttpError, serverError } from "./errors.js";
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

const pidexHttpHandler = Effect.gen(function* () {
  const metadata = yield* Metadata;
  const pi = makePiSdkService(makePiSdk());
  const manager = makeChatManager(pi, metadata);
  yield* Effect.addFinalizer(() => manager.shutdown());

  const csrf = randomBytes(32).toString("base64url");
  const roots = yield* allowedRoots();
  const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
  const webScriptHashes = yield* inlineScriptHashes(path.join(webRoot, "index.html"));
  const apiRouter = yield* createRpcApiRouter({ csrf, roots, metadata, manager, pi });
  const apiHandler = new RPCHandler(apiRouter, {
    errorStatusMap: {
      ...COMMON_ERROR_STATUS_MAP,
      ...apiErrorStatus,
      csrf: 403,
      internal_error: 500,
    },
    plugins: [new RequestLimitHandlerPlugin({ maxBodySize: 64 * 1024 })],
  });
  const webApp = yield* HttpStaticServer.make({ root: webRoot, spa: true });
  const rpcApp = HttpEffect.fromWebHandler(async (request) => {
    const result = await apiHandler.handle(request, {
      prefix: "/api/rpc",
      context: { req: request },
    });
    if (result.matched) return result.response;
    return new Response(
      JSON.stringify({ error: { code: "not_found", message: "API route not found" } }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  });
  const fileSystem = yield* FileSystem.FileSystem;

  const handleRequest = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* validateRequest(request);
    const route = new URL(request.url, "http://localhost").pathname;

    let response: HttpServerResponse.HttpServerResponse;
    if (route.startsWith("/api/rpc")) {
      response = yield* rpcApp;
    } else if (route.startsWith("/api/")) {
      return yield* HttpError.make({
        status: 404,
        code: "not_found",
        message: "API route not found",
      });
    } else {
      const webBuildExists = yield* fileSystem
        .exists(webRoot)
        .pipe(Effect.mapError((cause) => serverError("server.webRoot", cause)));
      if (!webBuildExists)
        return yield* HttpError.make({
          status: 503,
          code: "web_build_missing",
          message: "Web build is missing; run pnpm build",
        });
      response = yield* webApp.pipe(Effect.catch(HttpServerRespondable.toResponse));
      response = HttpServerResponse.setHeader(
        response,
        "Cache-Control",
        response.status === 200 && !response.headers["content-type"]?.startsWith("text/html")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    }

    if (route === "/api/rpc/live/events") {
      response = HttpServerResponse.setHeaders(response, {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
    }
    return response;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error: {
              code: error instanceof HttpError ? error.code : "internal_error",
              message: safeError(error),
            },
          },
          { status: error instanceof HttpError ? error.status : 500 },
        ),
      ),
    ),
    Effect.map(HttpServerResponse.setHeaders(securityHeaders(webScriptHashes))),
  );

  return { handleRequest, manager };
});

export async function createPidexNodeHandler() {
  const scope = await Effect.runPromise(Scope.make());
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= Effect.runPromise(Scope.close(scope, Exit.void)));

  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.merge(NodeHttpServer.layerHttpServices, makeMetadataLayer()),
        scope,
      ),
    );
    const nodeHandler = await Effect.runPromise(
      Effect.gen(function* () {
        const httpHandler = yield* pidexHttpHandler;
        const handleRequest = yield* NodeHttpServer.makeHandler(httpHandler.handleRequest, {
          scope,
        });
        return { ...httpHandler, handleRequest };
      }).pipe(Effect.provide(context), Scope.provide(scope)),
    );
    return { ...nodeHandler, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const main = Effect.scoped(
  Effect.gen(function* () {
    const port = yield* Effect.try({
      try: () => parsePort(),
      catch: (cause) => serverError("server.port", cause),
    });
    return yield* Effect.gen(function* () {
      const handler = yield* pidexHttpHandler;
      yield* HttpServer.serveEffect(handler.handleRequest);
      const server = yield* HttpServer.HttpServer;
      yield* Effect.logInfo(`Pidex ready at ${HttpServer.formatAddress(server.address)}`);
      return yield* Effect.never;
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }),
          makeMetadataLayer(),
        ),
      ),
    );
  }),
).pipe(
  Effect.tapError((error) =>
    Effect.sync(() => console.error(`Pidex cannot start: ${safeError(error)}`)),
  ),
);

function inlineScriptHashes(indexFile: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(indexFile))) return [];
    const html = yield* fileSystem.readFileString(indexFile);
    return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .filter((script): script is string => Boolean(script))
      .map((script) => createHash("sha256").update(script).digest("base64"));
  }).pipe(Effect.mapError((cause) => serverError("server.webScripts", cause)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  NodeRuntime.runMain(main, { disableErrorReporting: true });
