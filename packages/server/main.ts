import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Queue, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  ConversationUpdate,
  SendError,
} from "../api/index.js";

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
  let state: typeof Conversation.Type = {
    id: session.sessionId,
    modelName: session.model.name,
    status: "idle",
    messageCount: 0,
    entries: [],
    error: "",
  };
  const subscribers = new Set<(update: typeof ConversationUpdate.Type) => void>();
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
            Effect.sync(() =>
              publish({
                _tag: "TextDelta",
                id: messageId,
                delta,
              }),
            ),
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
    const accepted = yield* Effect.sync(() => {
      if (state.status !== "idle") return false;
      publish({
        _tag: "StateChanged",
        status: "running",
        messageCount: state.messageCount,
        error: "",
      });
      publish({ _tag: "EntryUpserted", entry: { id: crypto.randomUUID(), role: "user", text } });
      return true;
    });
    if (!accepted) return yield* new SendError({ message: "Wait for the current reply." });
    yield* Effect.tryPromise({
      try: () => session.prompt(text),
      catch: () =>
        new SendError({
          message: "Pi could not complete the prompt. Check your model and credentials.",
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          publish({
            _tag: "StateChanged",
            status: state.status,
            messageCount: state.messageCount,
            error: error.message,
          }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() =>
          publish({
            _tag: "StateChanged",
            status: "idle",
            messageCount: session.messages.length,
            error: state.error,
          }),
        ),
      ),
      Effect.forkIn(scope),
    );
  });
  const rpc = yield* RpcServer.toHttpEffectWebsocket(ConversationApi).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcSerialization.layerNdjson,
        ConversationApi.toLayer({
          Subscribe: () =>
            Stream.callback<typeof ConversationUpdate.Type>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const enqueue = (update: typeof ConversationUpdate.Type) => {
                    Queue.offerUnsafe(queue, update);
                  };
                  // Capture the snapshot and register synchronously: no missing or repeated deltas.
                  enqueue({ _tag: "Snapshot", conversation: state });
                  subscribers.add(enqueue);
                  return enqueue;
                }),
                (enqueue) =>
                  Effect.sync(() => {
                    subscribers.delete(enqueue);
                  }),
              ),
            ),
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

  function publish(update: typeof ConversationUpdate.Type) {
    state = applyConversationUpdate(state, update);
    for (const enqueue of subscribers) enqueue(update);
  }
});

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

class ShutdownError extends Schema.TaggedError<ShutdownError>()("ShutdownError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
