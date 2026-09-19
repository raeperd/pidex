import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";
import { ConversationApi } from "../api/index.js";

const program = Effect.gen(function* () {
  const token = yield* Schema.decodeUnknownEffect(Schema.String)(process.env.PIDEX_SERVER_TOKEN);
  delete process.env.PIDEX_SERVER_TOKEN;
  const { session } = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const cwd = process.cwd();
      const agentDir = getAgentDir();
      const resourceLoader = yield* Effect.try({
        try: () =>
          new DefaultResourceLoader({
            cwd,
            agentDir,
            // Package resolution reads raw settings, before the no-* filters run.
            settingsManager: SettingsManager.inMemory(),
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            systemPrompt: "",
            systemPromptOverride: () => undefined,
            appendSystemPrompt: [],
          }),
        catch: () => new StartupError(),
      });
      yield* Effect.tryPromise({
        try: () => resourceLoader.reload(),
        catch: () => new StartupError(),
      });
      const settingsManager = yield* Effect.try({
        try: () => SettingsManager.create(cwd, agentDir),
        catch: () => new StartupError(),
      });
      const modelRuntime = yield* Effect.tryPromise({
        try: () => ModelRuntime.create(),
        catch: () => new StartupError(),
      });
      return yield* Effect.tryPromise({
        try: () =>
          createAgentSession({
            cwd,
            agentDir,
            resourceLoader,
            settingsManager,
            modelRuntime,
            tools: ["read", "bash", "edit", "write"],
          }),
        catch: () => new StartupError(),
      });
    }),
    ({ session: acquired }) => Effect.sync(() => acquired.dispose()),
  );
  if (!session.model || !session.sessionFile || session.isStreaming)
    return yield* new StartupError();
  const modelName = session.model.name;
  const rpc = yield* RpcServer.toHttpEffect(ConversationApi).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcSerialization.layerJson,
        ConversationApi.toLayer({
          GetConversation: () =>
            Effect.succeed({
              id: session.sessionId,
              modelName,
              status: "idle",
              messageCount: session.messages.length,
            }),
        }),
      ),
    ),
  );
  const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.authorization !== `Bearer ${token}` ||
        request.headers.origin !== "pidex://app"
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      if (request.method !== "POST" || request.url !== "/rpc/")
        return HttpServerResponse.empty({ status: 404 });
      return yield* rpc;
    }),
  );
  if (server.address._tag !== "TcpAddress") return yield* new StartupError();
  process.send?.({ port: server.address.port, sessionFile: session.sessionFile });
  yield* Effect.never;
});

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
