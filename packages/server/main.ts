import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Schema, SubscriptionRef } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";
import { Conversation, ConversationApi, SendError } from "../api/index.js";

const program = Effect.gen(function* () {
  const serverSecret = yield* Schema.decodeUnknownEffect(Schema.String)(
    process.env.PIDEX_SERVER_SECRET,
  );
  delete process.env.PIDEX_SERVER_SECRET;
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
    ({ session: acquired }) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => acquired.dispose(),
          catch: () => new ShutdownError(),
        });
        yield* Effect.tryPromise({
          try: () => acquired.settingsManager.flush(),
          catch: () => new ShutdownError(),
        });
        const errors = yield* Effect.sync(() => acquired.settingsManager.drainErrors());
        if (errors.length > 0) return yield* new ShutdownError();
      }).pipe(Effect.catch(() => Effect.logError("Could not flush Pi settings during shutdown"))),
  );
  if (!session.model || !session.sessionFile || session.isStreaming)
    return yield* new StartupError();
  const scope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<typeof Conversation.Type>({
    id: session.sessionId,
    modelName: session.model.name,
    status: "idle",
    messageCount: 0,
    entries: [],
    error: "",
  });
  let messageId = "";
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "assistant") {
          messageId = crypto.randomUUID();
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          Effect.runSync(
            SubscriptionRef.update(state, (current): typeof Conversation.Type => ({
              ...current,
              entries: current.entries.some((entry) => entry.id === messageId)
                ? current.entries.map((entry) =>
                    entry.id === messageId ? { ...entry, text: entry.text + delta } : entry,
                  )
                : [...current.entries, { id: messageId, role: "assistant", text: delta }],
            })),
          );
        }
      }),
    ),
    (unsubscribe) =>
      Effect.tryPromise({
        try: () => session.abort(),
        catch: () => new ShutdownError(),
      }).pipe(
        Effect.catch(() => Effect.logError("Could not cancel Pi during shutdown")),
        Effect.ensuring(Effect.sync(unsubscribe)),
      ),
  );
  const send = Effect.fn(function* ({ text }: { text: string }) {
    if (!text.trim()) return yield* new SendError({ message: "Enter a prompt." });
    const accepted = yield* SubscriptionRef.modify(
      state,
      (current): [boolean, typeof Conversation.Type] =>
        current.status !== "idle"
          ? [false, current]
          : [
              true,
              {
                ...current,
                status: "running",
                error: "",
                entries: [...current.entries, { id: crypto.randomUUID(), role: "user", text }],
              },
            ],
    );
    if (!accepted) return yield* new SendError({ message: "Wait for the current reply." });
    yield* Effect.tryPromise({
      try: () => session.prompt(text),
      catch: () =>
        new SendError({
          message: "Pi could not complete the prompt. Check your model and credentials.",
        }),
    }).pipe(
      Effect.catch((error) =>
        SubscriptionRef.update(state, (current): typeof Conversation.Type => ({
          ...current,
          error: error.message,
        })),
      ),
      Effect.ensuring(
        SubscriptionRef.update(state, (current): typeof Conversation.Type => ({
          ...current,
          status: "idle",
          messageCount: session.messages.length,
        })),
      ),
      Effect.forkIn(scope),
    );
  });
  const rpc = yield* RpcServer.toHttpEffectWebsocket(ConversationApi).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcSerialization.layerNdjson,
        ConversationApi.toLayer({
          Subscribe: () => SubscriptionRef.changes(state),
          Send: (payload) => send(payload).pipe(Effect.uninterruptible),
        }),
      ),
    ),
  );
  const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.authorization !== `Bearer ${serverSecret}` ||
        request.headers.origin !== "pidex://app"
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      if (request.method !== "GET" || request.url !== "/rpc/")
        return HttpServerResponse.empty({ status: 404 });
      return yield* rpc;
    }),
  );
  if (server.address._tag !== "TcpAddress") return yield* new StartupError();
  process.send?.({ port: server.address.port, sessionFile: session.sessionFile });
  yield* Effect.never;
});

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

class ShutdownError extends Schema.TaggedError<ShutdownError>()("ShutdownError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
