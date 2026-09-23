import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  createAgentSession,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeResult,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  ConversationUpdate,
  SendError,
  RecoveryError,
  SubscribeError,
  SetupError,
  StopError,
  HistoryError,
  NewSessionError,
  SavedSession,
  ProjectPath,
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
  let readySessionFile = recoveryFile ?? "";
  const rpc = yield* Effect.gen(function* () {
    const recoveryMissing = yield* Effect.gen(function* () {
      const recoveryContents = recoveryFile
        ? yield* Effect.tryPromise({
            try: () => readFile(recoveryFile, "utf8"),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              cause instanceof Error && "code" in cause && cause.code === "ENOENT"
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new RecoveryError({
                      message: `Cannot read saved history (${cause instanceof Error && "code" in cause ? String(cause.code) : "read error"}): ${recoveryFile}. Check file and folder permissions, then Restart. The file has not been replaced.`,
                    }),
                  ),
            ),
          )
        : undefined;
      if (recoveryContents !== undefined) {
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            type: Schema.Literal("session"),
            version: Schema.Literal(3),
            id: Schema.String,
            cwd: Schema.String,
          }),
        )(
          yield* Effect.try({
            try: () => JSON.parse(recoveryContents.split("\n")[0] ?? ""),
            catch: () =>
              new RecoveryError({
                message: `Cannot read saved history: ${recoveryFile}. The session header is invalid. Restore a valid Pi session file, then Restart. The file has not been replaced.`,
              }),
          }),
        ).pipe(
          Effect.mapError(
            () =>
              new RecoveryError({
                message: `Cannot read saved history: ${recoveryFile}. The session header is invalid or unsupported. Restore a valid Pi session file, then Restart. The file has not been replaced.`,
              }),
          ),
        );
      }

      return Boolean(recoveryFile) && recoveryContents === undefined;
    });

    let prepared: CreateAgentSessionRuntimeResult | undefined;
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const createRuntime = async ({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager,
    }: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
    }): Promise<CreateAgentSessionRuntimeResult> => {
      if (prepared) {
        const result = prepared;
        prepared = undefined;
        return result;
      }
      const resourceLoader = new DefaultResourceLoader({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        // Package resolution reads raw settings, before the no-* filters run.
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: "",
        systemPromptOverride: () => undefined,
        appendSystemPrompt: [],
      });
      await resourceLoader.reload();
      const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir);
      const modelRuntime = await ModelRuntime.create();
      const result = await createAgentSession({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        resourceLoader,
        settingsManager,
        modelRuntime,
        sessionManager,
        tools: ["read", "bash", "edit", "write"],
      });
      return {
        ...result,
        services: {
          cwd: runtimeCwd,
          agentDir: runtimeAgentDir,
          resourceLoader,
          settingsManager,
          modelRuntime,
          diagnostics: [],
        },
        diagnostics: [],
      };
    };
    const runtime = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const sessionManager = yield* Effect.try({
          try: () =>
            recoveryFile && !recoveryMissing
              ? SessionManager.open(recoveryFile, undefined, cwd)
              : SessionManager.create(cwd),
          catch: () =>
            recoveryFile
              ? new RecoveryError({
                  message: `Cannot read saved history: ${recoveryFile}. Check file permissions and restore a valid Pi session, then Restart. The file has not been replaced.`,
                })
              : new RecoveryError({
                  message: `Cannot access saved history: ${join(agentDir, "sessions")}. Check file and folder permissions, then choose the project again. Saved files have not been changed.`,
                }),
        });
        return yield* Effect.tryPromise({
          try: () => createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager }),
          catch: () => new StartupError(),
        });
      }),
      (acquired) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => acquired.dispose(),
            catch: () => new ShutdownError(),
          });
          yield* Effect.tryPromise({
            try: () => acquired.session.settingsManager.flush(),
            catch: () => new ShutdownError(),
          });
          const errors = yield* Effect.sync(() => acquired.session.settingsManager.drainErrors());
          if (errors.length > 0) return yield* new ShutdownError();
        }).pipe(Effect.catch(() => Effect.logError("Could not flush Pi settings during shutdown"))),
    );
    let session = runtime.session;
    if (!session.sessionFile || session.isStreaming) return yield* new StartupError();
    const listSessions = Effect.fn(function* ({ projectPath }: { projectPath: string }) {
      const directory = session.sessionManager.getSessionDir();
      // Keep this error factory local to discovery, its sole consumer.
      // oxlint-disable-next-line consistent-function-scoping
      const unreadable = (path = directory) =>
        new HistoryError({
          path,
          message: `Cannot read saved history: ${path}. Check file and folder permissions or restore a valid Pi session, then Retry. Saved files have not been changed.`,
        });
      if (projectPath !== process.cwd())
        return yield* new HistoryError({
          path: projectPath,
          message:
            "This is not the selected project. Open the project before listing its sessions.",
        });
      // Pi silently skips unreadable files/directories. Inventory first so omissions are visible.
      const files = yield* Effect.tryPromise({
        try: () => readdir(directory),
        catch: () => unreadable(),
      });
      const metadata = new Map(
        (yield* Effect.tryPromise({
          try: () => SessionManager.list(projectPath, directory),
          catch: () => unreadable(),
        })).map((info) => [info.path, info]),
      );
      const sessions: (typeof SavedSession.Type)[] = [];
      const errors: HistoryError[] = [];
      for (const filename of files.filter((file) => file.endsWith(".jsonl"))) {
        const path = join(directory, filename);
        const info = metadata.get(path);
        if (!info) {
          errors.push(unreadable(path));
          continue;
        }
        yield* Effect.gen(function* () {
          const headerPath = yield* Schema.decodeUnknownEffect(ProjectPath)(info.cwd).pipe(
            Effect.mapError(() => unreadable(path)),
          );
          const canonicalPath = yield* Effect.tryPromise({
            try: () => realpath(headerPath),
            catch: () => unreadable(path),
          });
          // Pi's encoded directory names can collide; the history header remains authoritative.
          if (canonicalPath !== projectPath) return;
          const value = yield* Effect.try({
            try: () => ({
              projectPath,
              sessionId: info.id,
              sessionFile: path,
              title: (info.name?.trim() || info.firstMessage.trim() || "Untitled session").slice(
                0,
                200,
              ),
              modified: info.modified.toISOString(),
            }),
            catch: () => unreadable(path),
          });
          const saved = yield* Schema.decodeUnknownEffect(SavedSession)(value).pipe(
            Effect.mapError(() => unreadable(path)),
          );
          sessions.push(saved);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              errors.push(error);
            }),
          ),
        );
      }
      sessions.sort((a, b) => b.modified.localeCompare(a.modified));
      return { projectPath, sessions, errors };
    });
    const model = session.model;
    const checkSetup = Effect.fn(function* (target: typeof session) {
      const provider = target.settingsManager.getDefaultProvider();
      const modelId = target.settingsManager.getDefaultModel();
      if (provider && modelId && !target.modelRuntime.getModel(provider, modelId)) {
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
      const candidateModel = target.model;
      if (!candidateModel) return yield* authenticationError;
      const auth = yield* Effect.tryPromise({
        try: () => target.modelRuntime.getAuth(candidateModel),
        catch: () => authenticationError,
      });
      // Pi also resolves AWS credential chains and Vertex ADC without API keys or headers.
      if (!auth) return yield* authenticationError;
      return null;
    });
    let setupError = yield* checkSetup(session).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    );
    const scope = yield* Effect.scope;
    let state: typeof Conversation.Type = {
      id: session.sessionId,
      projectPath: process.cwd(),
      modelName: setupError ? "Setup required" : (model?.name ?? "Setup required"),
      setupError,
      status: "idle",
      runId: null,
      messageCount: session.messages.length,
      entries: [],
      error: recoveryMissing
        ? "Saved history is missing. Started a fresh conversation in the same project; no prompt was replayed."
        : recoveryNotice(),
    };
    yield* Effect.sync(() => {
      // Read the active saved branch, including history before compaction.
      for (const item of session.sessionManager.getBranch()) {
        if (item.type !== "message") continue;
        const message = item.message;
        switch (message.role) {
          case "user":
          case "assistant": {
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
            break;
          }
          case "toolResult": {
            const entry = state.entries.find((candidate) => candidate.id === message.toolCallId);
            if (entry?.role === "tool")
              state = applyConversationUpdate(state, {
                _tag: "EntryUpserted",
                entry: {
                  ...entry,
                  result: JSON.stringify(
                    { content: message.content, details: message.details },
                    null,
                    2,
                  ),
                  status: message.isError ? "failed" : "completed",
                },
              });
            break;
          }
        }
      }
    });
    const subscribers = new Set<(update: typeof ConversationUpdate.Type, bytes: number) => void>();
    let active:
      | {
          id: string;
          failed: boolean;
          started: Deferred.Deferred<void>;
          finished: Deferred.Deferred<void>;
          stopped: Deferred.Deferred<void, StopError>;
        }
      | undefined;
    let messageId = "";
    // oxlint-disable-next-line consistent-function-scoping
    let unsubscribe = () => {};
    let replacing = false;
    const attach = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const subscribeCurrent = () => {
          const boundSession = session;
          unsubscribe = boundSession.subscribe((event) => {
            if (replacing || boundSession !== session) return;
            if ((event.type === "agent_start" || event.type === "compaction_start") && active) {
              // Pi can start the pending turn after aborting preflight compaction.
              const run = active;
              if (event.type === "agent_start" && state.status === "stopping")
                session.agent.abort();
              if (event.type === "compaction_start") {
                // Pi installs the compaction controller after notifying subscribers.
                queueMicrotask(() => {
                  if (active === run && state.status === "stopping") session.abortCompaction();
                });
              }
              Effect.runSync(Deferred.succeed(run.started, undefined));
            }
            Effect.runSync(
              Effect.sync(() => {
                switch (event.type) {
                  case "message_end":
                    // Pi can remove failed replies while compacting or retrying.
                    // Only a later completed assistant attempt replaces this outcome.
                    if (active && event.message.role === "assistant")
                      active.failed = event.message.stopReason === "error";
                    return;
                  case "compaction_end":
                    if (active && !event.aborted && event.errorMessage) active.failed = true;
                    return;
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
            );
          });
        };
        subscribeCurrent();
        return subscribeCurrent;
      }),
      () =>
        Effect.tryPromise({
          try: () => session.abort(),
          catch: () => new ShutdownError(),
        }).pipe(
          Effect.catch(() => Effect.logError("Could not cancel Pi during shutdown")),
          Effect.ensuring(Effect.sync(() => unsubscribe())),
        ),
    );
    runtime.setBeforeSessionInvalidate(() => unsubscribe());
    const newSession = Effect.fn(function* ({
      projectPath,
      sessionId,
    }: {
      projectPath: string;
      sessionId: string;
    }) {
      if (projectPath !== cwd || sessionId !== session.sessionId)
        return yield* new NewSessionError({
          message: "The selected session changed. Refresh and try again.",
        });
      if (replacing || state.status !== "idle" || active)
        return yield* new NewSessionError({
          message: "Wait for the current reply or Stop to finish.",
        });
      replacing = true;
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => access(session.sessionManager.getSessionDir(), constants.W_OK),
          catch: () =>
            new NewSessionError({
              message: "Pi history is not writable. Check folder permissions, then Retry.",
            }),
        });
        const next = yield* Effect.tryPromise({
          try: () =>
            createRuntime({
              cwd,
              agentDir,
              sessionManager: SessionManager.create(cwd, session.sessionManager.getSessionDir()),
            }),
          catch: () =>
            new NewSessionError({
              message:
                "Could not prepare a new session. Check project and Pi history permissions, then Retry.",
            }),
        });
        prepared = next;
        const outcome = yield* Effect.tryPromise({
          try: () => runtime.newSession(),
          catch: () => {
            publish({
              _tag: "StateChanged",
              status: "unavailable",
              runId: null,
              messageCount: state.messageCount,
              error:
                "Session replacement failed. Restart the backend to recover the previous session.",
            });
            return new NewSessionError({
              message:
                "Could not start a new session. Restart the backend to recover the previous session.",
            });
          },
        });
        if (outcome.cancelled)
          return yield* new NewSessionError({ message: "New session was cancelled. Retry." });
        session = runtime.session;
        messageId = "";
        setupError = yield* checkSetup(session).pipe(
          Effect.catch((error) => Effect.succeed(error)),
        );
        state = {
          id: session.sessionId,
          projectPath: cwd,
          modelName: setupError ? "Setup required" : (session.model?.name ?? "Setup required"),
          setupError,
          status: "idle",
          runId: null,
          messageCount: 0,
          entries: [],
          error: "",
        };
        attach();
        publish({ _tag: "Snapshot", conversation: state });
        if (!session.sessionFile)
          return yield* new NewSessionError({
            message: "Pi did not provide a recovery locator. Restart the backend and Retry.",
          });
        return { sessionFile: session.sessionFile };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            replacing = false;
            prepared?.session.dispose();
            prepared = undefined;
          }),
        ),
      );
    });
    const send = Effect.fn(function* ({
      text,
      submissionId,
    }: {
      text: string;
      submissionId?: string;
    }) {
      if (state.setupError) return yield* new SendError({ message: state.setupError.message });
      if (!text.trim()) return yield* new SendError({ message: "Enter a prompt." });
      if (replacing || state.status !== "idle")
        return yield* new SendError({ message: "Wait for the current reply." });
      const run = {
        id: crypto.randomUUID(),
        failed: false,
        started: yield* Deferred.make<void>(),
        finished: yield* Deferred.make<void>(),
        stopped: yield* Deferred.make<void, StopError>(),
      };
      active = run;
      publish({
        _tag: "StateChanged",
        status: "running",
        runId: run.id,
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
      yield* Effect.tryPromise({
        try: () => session.prompt(text),
        catch: () =>
          new SendError({
            message: "Pi could not complete the prompt. Check your model and credentials.",
          }),
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            return run.failed && state.status !== "stopping"
              ? Effect.fail(
                  new SendError({
                    message:
                      "The model provider could not complete the reply. Check provider availability, quota, and Pi authentication, then try again. For context-limit failures, shorten the prompt or select a larger-context model in Pi before restarting Pidex.",
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
              runId: state.runId,
              messageCount: state.messageCount,
              error: error.message,
            }),
          ),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            // A preflight failure may finish without emitting agent_start.
            yield* Deferred.succeed(run.started, undefined);
            yield* Deferred.succeed(run.finished, undefined);
            if (state.status !== "stopping") finishRun();
          }),
        ),
        Effect.forkIn(scope),
      );
    });
    const stop = Effect.fn(function* ({ runId }: { runId: string }) {
      const run = active;
      if (!run || run.id !== runId) return;
      if (state.status === "stopping") return yield* Deferred.await(run.stopped);
      run.stopped = yield* Deferred.make<void, StopError>();
      publish({
        _tag: "StateChanged",
        status: "stopping",
        runId,
        messageCount: state.messageCount,
        error: "",
      });
      return yield* Effect.gen(function* () {
        // abort() before Pi starts is a no-op. Wait for start or preflight failure.
        yield* Deferred.await(run.started);
        yield* Effect.tryPromise({
          try: () => session.abort(),
          catch: () => new StopError({ message: "Pi could not stop. Try Stop again." }),
        });
        yield* Deferred.await(run.finished);
        finishRun();
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            publish({
              _tag: "StateChanged",
              status: "running",
              runId,
              messageCount: state.messageCount,
              error: error.message,
            });
          }),
        ),
        (effect) => Deferred.complete(run.stopped, effect),
        Effect.andThen(Deferred.await(run.stopped)),
      );
    });
    readySessionFile = session.sessionFile;
    return yield* RpcServer.toHttpEffectWebsocket(ConversationApi).pipe(
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
            ListSessions: listSessions,
            NewSession: (payload) => newSession(payload).pipe(Effect.uninterruptible),
            Stop: (payload) => stop(payload).pipe(Effect.uninterruptible),
            Send: (payload) => send(payload).pipe(Effect.uninterruptible),
          }),
        ),
      ),
    );

    function recoveryNotice() {
      const last = session.messages.at(-1);
      const unfinished =
        Boolean(recoveryFile) &&
        (last?.role === "user" ||
          last?.role === "toolResult" ||
          (last?.role === "assistant" && last.stopReason === "toolUse"));
      return interrupted || unfinished
        ? "The previous run was interrupted. Saved history was restored; send a prompt to continue."
        : "";
    }

    function finishRun() {
      active = undefined;
      publish({
        _tag: "StateChanged",
        status: "idle",
        runId: null,
        messageCount: session.messages.length,
        error: state.error,
      });
    }

    function publish(update: typeof ConversationUpdate.Type) {
      state = applyConversationUpdate(state, update);
      if (subscribers.size === 0) return;
      const bytes = Buffer.byteLength(JSON.stringify(update));
      for (const enqueue of subscribers) enqueue(update, bytes);
    }
  }).pipe(
    Effect.catchTag("RecoveryError", (error) =>
      RpcServer.toHttpEffectWebsocket(ConversationApi).pipe(
        Effect.provide(
          Layer.mergeAll(
            RpcSerialization.layerNdjson,
            ConversationApi.toLayer({
              Subscribe: () => Stream.fail(error),
              ListSessions: ({ projectPath }) =>
                Effect.fail(new HistoryError({ path: projectPath, message: error.message })),
              Stop: () => Effect.fail(new StopError({ message: error.message })),
              Send: () => Effect.fail(new SendError({ message: error.message })),
              NewSession: () => Effect.fail(new NewSessionError({ message: error.message })),
            }),
          ),
        ),
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
  process.send?.({ port: server.address.port, sessionFile: readySessionFile });
  yield* Effect.never;
});

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

class ShutdownError extends Schema.TaggedError<ShutdownError>()("ShutdownError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
