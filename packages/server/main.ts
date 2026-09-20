import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Layer, Queue, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  ConversationUpdate,
  SendError,
  SubscribeError,
  SetupError,
} from "../api/index.js";

const program = Effect.gen(function* () {
  const serverSecret = yield* Schema.decodeUnknownEffect(Schema.String)(
    process.env.PIDEX_SERVER_SECRET,
  );
  delete process.env.PIDEX_SERVER_SECRET;
  const recoveryFile = process.env.PIDEX_SESSION_FILE;
  const interrupted = process.env.PIDEX_INTERRUPTED === "1";
  delete process.env.PIDEX_SESSION_FILE;
  delete process.env.PIDEX_INTERRUPTED;
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
      const sessionManager = yield* Effect.try({
        try: () =>
          recoveryFile
            ? SessionManager.open(recoveryFile, undefined, cwd)
            : SessionManager.create(cwd),
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
            sessionManager,
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
  if (!session.sessionFile || session.isStreaming) return yield* new StartupError();
  const model = session.model;
  const setupError = yield* Effect.gen(function* () {
    const provider = session.settingsManager.getDefaultProvider();
    const modelId = session.settingsManager.getDefaultModel();
    if (provider && modelId && !session.modelRuntime.getModel(provider, modelId)) {
      return yield* new SetupError({
        reason: "model",
        message:
          "Pi's default model could not be resolved. Open Pi in this project, use /model to select an available model and save it as the default, then restart Pidex. Check settings.json and models.json if you use a custom model.",
      });
    }
    const authenticationError = new SetupError({
      reason: "authentication",
      message:
        "Pi authentication is unavailable. Open Pi and use /login, or configure your provider's API key in the existing Pi setup, then restart Pidex.",
    });
    if (!model) return yield* authenticationError;
    const auth = yield* Effect.tryPromise({
      try: () => session.modelRuntime.getAuth(model),
      catch: () => authenticationError,
    });
    if (!auth || (!auth.auth.apiKey && !auth.auth.headers)) return yield* authenticationError;
    return null;
  }).pipe(Effect.catch((error) => Effect.succeed(error)));
  const scope = yield* Effect.scope;
  let state: typeof Conversation.Type = {
    id: session.sessionId,
    modelName: setupError ? "Setup required" : (model?.name ?? "Setup required"),
    setupError,
    status: "idle",
    messageCount: session.messages.length,
    entries: [],
    error: interrupted
      ? "The previous run was interrupted. Saved history was restored; send a prompt to continue."
      : "",
  };
  // Read the active saved branch, including history before compaction.
  for (const item of session.sessionManager.getBranch()) {
    if (item.type !== "message") continue;
    const message = item.message;
    if (message.role === "user" || message.role === "assistant") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      if (text)
        state = applyConversationUpdate(state, {
          _tag: "EntryUpserted",
          entry: { id: item.id, role: message.role, text },
        });
      if (message.role === "assistant")
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          state = applyConversationUpdate(state, {
            _tag: "EntryUpserted",
            entry: {
              id: part.id,
              role: "tool",
              name: part.name,
              input: JSON.stringify(part.arguments, null, 2),
              result: "Interrupted before a saved result.",
              status: "failed",
            },
          });
        }
    } else if (message.role === "toolResult") {
      const entry = state.entries.find((candidate) => candidate.id === message.toolCallId);
      if (entry?.role === "tool")
        state = applyConversationUpdate(state, {
          _tag: "EntryUpserted",
          entry: {
            ...entry,
            result: JSON.stringify({ content: message.content, details: message.details }, null, 2),
            status: message.isError ? "failed" : "completed",
          },
        });
    }
  }
  const subscribers = new Set<(update: typeof ConversationUpdate.Type, bytes: number) => void>();
  let messageId = "";
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      session.subscribe((event) =>
        Effect.runSync(
          Effect.sync(() => {
            switch (event.type) {
              case "message_start":
                if (event.message.role === "assistant") messageId = crypto.randomUUID();
                return;
              case "message_update":
                if (event.assistantMessageEvent.type !== "text_delta") return;
                publish({
                  _tag: "TextDelta",
                  id: messageId,
                  delta: event.assistantMessageEvent.delta,
                });
                return;
              case "tool_execution_start":
                publish({
                  _tag: "EntryUpserted",
                  entry: {
                    id: event.toolCallId,
                    role: "tool",
                    name: event.toolName,
                    input: JSON.stringify(event.args, null, 2),
                    result: "",
                    status: "running",
                  },
                });
                return;
              case "tool_execution_update":
              case "tool_execution_end": {
                const entry = state.entries.find((item) => item.id === event.toolCallId);
                if (entry?.role !== "tool") return;
                publish({
                  _tag: "EntryUpserted",
                  entry: {
                    ...entry,
                    result: JSON.stringify(
                      event.type === "tool_execution_end" ? event.result : event.partialResult,
                      null,
                      2,
                    ),
                    status:
                      event.type === "tool_execution_update"
                        ? "running"
                        : event.isError
                          ? "failed"
                          : "completed",
                  },
                });
                return;
              }
            }
          }),
        ),
      ),
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
  const send = Effect.fn(function* ({
    text,
    submissionId,
  }: {
    text: string;
    submissionId?: string;
  }) {
    if (state.setupError) return yield* new SendError({ message: state.setupError.message });
    if (!text.trim()) return yield* new SendError({ message: "Enter a prompt." });
    const accepted = yield* Effect.sync(() => {
      if (state.status !== "idle") return false;
      publish({
        _tag: "StateChanged",
        status: "running",
        messageCount: state.messageCount,
        error: "",
      });
      publish({
        _tag: "EntryUpserted",
        entry: {
          id: crypto.randomUUID(),
          role: "user",
          text,
          ...(submissionId === undefined ? {} : { submissionId }),
        },
      });
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
      Effect.andThen(
        Effect.suspend(() => {
          const lastReply = session.messages.findLast((message) => message.role === "assistant");
          return lastReply?.role === "assistant" && lastReply.stopReason === "error"
            ? Effect.fail(
                new SendError({
                  message:
                    "The model provider could not complete the reply. Check provider availability, quota, and Pi authentication, then try again.",
                }),
              )
            : Effect.void;
        }),
      ),
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
            Stream.unwrap(
              Effect.gen(function* () {
                // Include the item awaiting an RPC acknowledgement in both limits.
                const maxItems = 64;
                const maxBytes = 8 * 1024 * 1024;
                const queue = yield* Queue.bounded<
                  { update: typeof ConversationUpdate.Type; bytes: number },
                  SubscribeError
                >(maxItems);
                let items = 0;
                let bytes = 0;
                let deliveredBytes = 0;
                let failure: SubscribeError | undefined;
                const enqueue = (update: typeof ConversationUpdate.Type, size: number) => {
                  if (failure) return;
                  if (size > maxBytes || items >= maxItems || bytes + size > maxBytes) {
                    failure = new SubscribeError({
                      reason: size > maxBytes ? "payload-too-large" : "slow-consumer",
                      message:
                        size > maxBytes
                          ? "A subscription payload is too large to stream. Pi history is preserved."
                          : "The subscription fell behind. Subscribe again for the current conversation.",
                    });
                    subscribers.delete(enqueue);
                    Queue.failCauseUnsafe(queue, Cause.fail(failure));
                    return;
                  }
                  items++;
                  bytes += size;
                  Queue.offerUnsafe(queue, { update, bytes: size });
                };
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    // Registration and initial snapshot happen together, without a gap.
                    subscribers.add(enqueue);
                    const initial = {
                      _tag: "Snapshot",
                      conversation: state,
                    } satisfies typeof ConversationUpdate.Type;
                    enqueue(initial, Buffer.byteLength(JSON.stringify(initial)));
                  }),
                  () =>
                    Effect.sync(() => {
                      subscribers.delete(enqueue);
                    }).pipe(Effect.andThen(Queue.shutdown(queue))),
                );
                return Stream.fromEffectRepeat(
                  Effect.gen(function* () {
                    if (failure) return yield* failure;
                    // The next pull means the previous single-item chunk was acknowledged.
                    if (deliveredBytes > 0) {
                      items--;
                      bytes -= deliveredBytes;
                    }
                    const next = yield* Queue.take(queue);
                    deliveredBytes = next.bytes;
                    return next.update;
                  }),
                );
              }),
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
    if (subscribers.size === 0) return;
    const bytes = Buffer.byteLength(JSON.stringify(update));
    for (const enqueue of subscribers) enqueue(update, bytes);
  }
});

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

class ShutdownError extends Schema.TaggedError<ShutdownError>()("ShutdownError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
