import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  ConversationUpdate,
  HistoryError,
  ModelListError,
  ProjectPath,
  ProviderError,
  ReadSessionError,
  SavedSession,
  SendError,
  SessionLocator,
  SessionTarget,
  SetupError,
  StopError,
  SubscribeError,
} from "../api/index.js";

// The server holds no selected session: every request names its target, and a run opens its
// Pi session for the duration of that run only.
const program = Effect.gen(function* () {
  const serverSecret = yield* Schema.decodeUnknownEffect(Schema.String)(
    process.env.PIDEX_SERVER_SECRET,
  );
  delete process.env.PIDEX_SERVER_SECRET;
  const agentDir = getAgentDir();
  const scope = yield* Effect.scope;
  let active: Run | undefined;
  const subscribers = new Set<(update: typeof ConversationUpdate.Type, bytes: number) => void>();

  const readSession = Effect.fn(function* ({
    writable,
    ...target
  }: typeof SessionTarget.Type & { writable?: boolean }) {
    if (active && sameSession(active.target, target)) return active.conversation;
    // Only one run at a time: selecting another session waits for it.
    if (active)
      return yield* new ReadSessionError({
        reason: "unavailable",
        path: target.projectPath,
        message: "Wait for the current reply or Stop to finish.",
      });
    const located = yield* locate(target);
    // A new session draft must be able to save its first reply.
    if (writable)
      yield* Effect.tryPromise({
        try: () => access(located.directory, constants.W_OK),
        catch: () =>
          new ReadSessionError({
            reason: "unavailable",
            path: located.directory,
            message: "Pi history is not writable. Check folder permissions, then Retry.",
          }),
      });
    return yield* describe(located);
  });

  const send = Effect.fn(function* ({
    target,
    text,
    submissionId,
  }: {
    target: typeof SessionTarget.Type;
    text: string;
    submissionId?: string;
  }) {
    if (!text.trim()) return yield* new SendError({ message: "Enter a prompt." });
    if (active) return yield* new SendError({ message: "Wait for the current reply." });
    const run: Run = {
      id: crypto.randomUUID(),
      target,
      conversation: placeholder(target),
      session: undefined,
      messageId: "",
      failed: false,
      started: yield* Deferred.make<void>(),
      finished: yield* Deferred.make<void>(),
      stopped: yield* Deferred.make<void, StopError>(),
    };
    // Reserve the single run before any asynchronous preparation.
    active = run;
    const session = yield* Effect.gen(function* () {
      const located = yield* locate(target);
      const opened = yield* openSession(located).pipe(
        Effect.mapError(
          () =>
            new SendError({
              message:
                "Pi could not open this session. Check the project and Pi setup, then try again.",
            }),
        ),
      );
      const conversation = yield* conversationOf(opened, located).pipe(
        Effect.tap(({ setupError }) => (setupError ? Effect.fail(setupError) : Effect.void)),
        Effect.tapError(() => release(opened)),
      );
      run.conversation = { ...conversation, status: "running", runId: run.id };
      return opened;
    }).pipe(
      Effect.mapError((error) => new SendError({ message: error.message })),
      Effect.tapError(() =>
        Effect.sync(() => {
          active = undefined;
        }),
      ),
    );
    run.session = session;
    publish({
      _tag: "StateChanged",
      status: "running",
      runId: run.id,
      messageCount: run.conversation.messageCount,
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
    yield* Effect.gen(function* () {
      // Translates this run's Pi events into conversation updates.
      const unsubscribe = session.subscribe(
        // Pi emits several event variants.
        // oxlint-disable-next-line complexity
        (event: AgentSessionEvent) => {
          if (event.type === "agent_start" || event.type === "compaction_start") {
            // Pi can start the pending turn after aborting preflight compaction.
            if (event.type === "agent_start" && run.conversation.status === "stopping")
              session.agent.abort();
            if (event.type === "compaction_start") {
              // Pi installs the compaction controller after notifying subscribers.
              queueMicrotask(() => {
                if (active === run && run.conversation.status === "stopping")
                  session.abortCompaction();
              });
            }
            Effect.runSync(Deferred.succeed(run.started, undefined));
          }
          switch (event.type) {
            case "message_end":
              // Pi can remove failed replies while compacting or retrying.
              // Only a later completed assistant attempt replaces this outcome.
              if (event.message.role === "assistant")
                run.failed = event.message.stopReason === "error";
              return;
            case "compaction_end":
              if (!event.aborted && event.errorMessage) run.failed = true;
              return;
            case "message_start":
              if (event.message.role === "assistant") run.messageId = crypto.randomUUID();
              return;
            case "message_update":
              if (event.assistantMessageEvent.type !== "text_delta") return;
              publish({
                _tag: "TextDelta",
                id: run.messageId,
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
              const entry = run.conversation.entries.find((item) => item.id === event.toolCallId);
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
        },
      );
      yield* Effect.tryPromise({
        try: () => session.prompt(text),
        catch: () =>
          new SendError({
            message: "Pi could not complete the prompt. Check your model and credentials.",
          }),
      }).pipe(
        // Quit interrupts this fiber; settle Pi so the aborted turn is saved first.
        Effect.onInterrupt(() => Effect.promise(() => session.abort())),
        Effect.ensuring(Effect.sync(unsubscribe)),
      );
    }).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          run.failed && run.conversation.status !== "stopping"
            ? Effect.fail(
                new SendError({
                  message:
                    "The model provider could not complete the reply. Check provider availability, quota, and Pi authentication, then try again. For context-limit failures, shorten the prompt or select a larger-context model in Pi before restarting Pidex.",
                }),
              )
            : Effect.void,
        ),
      ),
      Effect.catch((error) =>
        Effect.sync(() =>
          publish({
            _tag: "StateChanged",
            status: run.conversation.status,
            runId: run.id,
            messageCount: run.conversation.messageCount,
            error: error.message,
          }),
        ),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const messageCount = session.messages.length;
          yield* release(session);
          // A preflight failure may finish without emitting agent_start.
          yield* Deferred.succeed(run.started, undefined);
          yield* Deferred.succeed(run.finished, undefined);
          if (run.conversation.status !== "stopping") finishRun(run, messageCount);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const stop = Effect.fn(function* ({ runId }: { runId: string }) {
    const run = active;
    if (!run || run.id !== runId) return;
    if (run.conversation.status === "stopping") return yield* Deferred.await(run.stopped);
    run.stopped = yield* Deferred.make<void, StopError>();
    publish({
      _tag: "StateChanged",
      status: "stopping",
      runId,
      messageCount: run.conversation.messageCount,
      error: "",
    });
    return yield* Effect.gen(function* () {
      // abort() before Pi starts is a no-op. Wait for start or preflight failure.
      yield* Deferred.await(run.started);
      yield* Effect.tryPromise({
        try: async () => run.session?.abort(),
        catch: () => new StopError({ message: "Pi could not stop. Try Stop again." }),
      });
      yield* Deferred.await(run.finished);
      finishRun(run, run.session?.messages.length ?? run.conversation.messageCount);
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          publish({
            _tag: "StateChanged",
            status: "running",
            runId,
            messageCount: run.conversation.messageCount,
            error: error.message,
          });
        }),
      ),
      (effect) => Deferred.complete(run.stopped, effect),
      Effect.andThen(Deferred.await(run.stopped)),
    );
  });

  const listSessions = Effect.fn(function* ({ projectPath }: { projectPath: string }) {
    const project = yield* locateProject(projectPath).pipe(
      Effect.mapError((error) => new HistoryError({ path: error.path, message: error.message })),
    );
    const directory = project.directory;
    // Keep this error factory local to discovery, its sole consumer.
    // oxlint-disable-next-line consistent-function-scoping
    const unreadable = (path = directory) =>
      new HistoryError({
        path,
        message: `Cannot read saved history: ${path}. Check file and folder permissions or restore a valid Pi session, then Retry. Saved files have not been changed.`,
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

  const listModels = Effect.fn(function* ({
    projectPath,
    sessionId,
  }: {
    projectPath: string;
    sessionId: string;
  }) {
    // Credential checks run per provider below, where a held auth lock is bounded.
    const modelRuntime = yield* Effect.tryPromise({
      try: () => ModelRuntime.create({ refreshOnCreate: false }),
      catch: () =>
        new ModelListError({
          message: "Pi could not load its model catalog. Check Pi, then Retry.",
        }),
    });
    // Local and cached catalogs only; per-provider checks keep one failure from hiding others.
    const [available, errors] = yield* Effect.partition(
      modelRuntime.getProviders(),
      (provider) =>
        Effect.tryPromise((signal) => modelRuntime.getAvailable(provider.id, { signal })).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(
            () =>
              new ProviderError({
                provider: provider.id,
                message: `Pi could not check ${provider.name} authentication. Check its credentials in Pi, then Retry.`,
              }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return {
      projectPath,
      sessionId,
      models: available.flat().map(({ provider, id, name }) => ({ provider, id, name })),
      errors,
    };
  });

  // Resolves a target to its project and Pi session history without changing either.
  const locate = Effect.fn(function* (target: typeof SessionTarget.Type) {
    const project = yield* locateProject(target.projectPath);
    let file = target.sessionFile;
    if (!file) {
      // A session draft gets its file with the first saved reply; Pi names it after the ID.
      const files = yield* Effect.tryPromise(() => readdir(project.directory)).pipe(
        Effect.catch(() => Effect.succeed<string[]>([])),
      );
      const saved = files.find((name) => name.endsWith(`_${target.sessionId}.jsonl`));
      if (!saved)
        return {
          cwd: project.path,
          directory: project.directory,
          manager: SessionManager.create(project.path, project.directory, {
            id: target.sessionId,
          }),
        };
      file = join(project.directory, saved);
    }
    const path = file;
    const failure = (reason?: string) =>
      new ReadSessionError({
        reason: reason === "ENOENT" ? "missing" : "unavailable",
        path,
        ...(reason === undefined ? {} : { code: reason }),
        message:
          "Cannot resume saved history. The file is missing, unreadable, or changed. Check the session file and folder permissions, then Retry. Your current session is preserved.",
      });
    const content = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => failure(errorCode(cause)),
    });
    const canonicalFile = yield* Effect.tryPromise({
      try: () => realpath(path),
      catch: (cause) => failure(errorCode(cause)),
    });
    const canonicalDirectory = yield* Effect.tryPromise({
      try: () => realpath(project.directory),
      catch: (cause) => failure(errorCode(cause)),
    });
    if (dirname(canonicalFile) !== canonicalDirectory) return yield* failure();
    const header = yield* Effect.try({
      try: () => {
        const lines = content.trimEnd().split("\n");
        for (const line of lines) JSON.parse(line);
        return JSON.parse(lines[0] ?? "");
      },
      catch: () => failure(),
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            type: Schema.Literal("session"),
            version: Schema.Literal(3),
            id: SessionLocator.fields.sessionId,
            cwd: ProjectPath,
          }),
        ),
      ),
      Effect.mapError(() => failure()),
    );
    if (header.id !== target.sessionId) return yield* failure();
    const headerProject = yield* Effect.tryPromise({
      try: () => realpath(header.cwd),
      catch: () => failure(),
    });
    if (headerProject !== project.path) return yield* failure();
    return {
      cwd: project.path,
      directory: project.directory,
      manager: yield* Effect.try({
        try: () => SessionManager.open(path, undefined, project.path),
        catch: () => failure(),
      }),
    };
  });

  const locateProject = Effect.fn(function* (projectPath: string) {
    const unavailable = new ReadSessionError({
      reason: "missing",
      path: projectPath,
      message: `Could not open ${projectPath}. The folder is missing or unreadable. Restore it, then select the project again. Your current session is preserved.`,
    });
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(projectPath),
      catch: () => unavailable,
    });
    const info = yield* Effect.tryPromise({ try: () => stat(canonical), catch: () => unavailable });
    if (canonical !== projectPath || !info.isDirectory()) return yield* unavailable;
    yield* Effect.tryPromise({
      try: () => access(canonical, constants.R_OK | constants.X_OK),
      catch: () => unavailable,
    });
    // Pi's default per-project history directory; creating it needs the sessions root.
    const directory = yield* Effect.try({
      try: () => SessionManager.create(canonical).getSessionDir(),
      catch: () =>
        new ReadSessionError({
          reason: "unavailable",
          path: join(agentDir, "sessions"),
          message: `Cannot access saved history: ${join(agentDir, "sessions")}. Check file and folder permissions, then choose the project again. Saved files have not been changed.`,
        }),
    });
    return { path: canonical, directory };
  });

  // Each open rebuilds project-bound resources: context files, settings, models, and tools.
  const openSession = Effect.fn(function* (target: Located) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const resourceLoader = new DefaultResourceLoader({
          cwd: target.cwd,
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
        });
        await resourceLoader.reload();
        const modelRuntime = await ModelRuntime.create({ signal });
        // An abandoned open must not touch the session history.
        signal.throwIfAborted();
        const { session } = await createAgentSession({
          cwd: target.cwd,
          agentDir,
          resourceLoader,
          settingsManager: SettingsManager.create(target.cwd, agentDir),
          modelRuntime,
          sessionManager: target.manager,
          tools: ["read", "bash", "edit", "write"],
        });
        if (signal.aborted) {
          session.dispose();
          signal.throwIfAborted();
        }
        return session;
      },
      catch: () => new OpenError(),
    }).pipe(
      // Pi's credential refresh can wait on a held lock; bound it even in uninterruptible RPCs.
      Effect.interruptible,
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new OpenError()),
    );
  });

  // Saves pending Pi settings, reports persistence errors, and frees the session's resources.
  const release = Effect.fn(function* (session: AgentSession) {
    yield* Effect.promise(() => session.settingsManager.flush());
    if (session.settingsManager.drainErrors().length > 0)
      yield* Effect.logError("Could not save Pi settings");
    yield* Effect.try(() => session.dispose()).pipe(
      Effect.catch(() => Effect.logError("Could not release a Pi session")),
    );
  });

  const describe = Effect.fn(function* (target: Located) {
    // Pi's session setup records model entries; a throwaway copy keeps reads out of history.
    const header = target.manager.getHeader();
    const { conversation, interrupted } = yield* Effect.acquireUseRelease(
      openSession({
        cwd: target.cwd,
        manager: SessionManager.inMemory(
          target.cwd,
          undefined,
          header ? [header, ...target.manager.getEntries()] : undefined,
        ),
      }).pipe(
        Effect.mapError(
          () =>
            new ReadSessionError({
              reason: "unavailable",
              path: target.cwd,
              message:
                "Could not prepare this session. Check project and Pi history permissions, then Retry.",
            }),
        ),
      ),
      (view) =>
        Effect.gen(function* () {
          const last = view.messages.at(-1);
          return {
            conversation: yield* conversationOf(view, target),
            interrupted:
              last?.role === "user" ||
              last?.role === "toolResult" ||
              (last?.role === "assistant" && last.stopReason === "toolUse"),
          };
        }),
      release,
    );
    return {
      ...conversation,
      error: interrupted
        ? "The previous run was interrupted. Saved history was restored; send a prompt to continue."
        : "",
    };
  });

  // Saved Pi history contains several message variants and tool outcomes.
  // oxlint-disable-next-line complexity
  const conversationOf = Effect.fn(function* (session: AgentSession, target: Located) {
    const checkSetup = Effect.fn(function* (view: AgentSession) {
      const provider = view.settingsManager.getDefaultProvider();
      const modelId = view.settingsManager.getDefaultModel();
      if (provider && modelId && !view.modelRuntime.getModel(provider, modelId)) {
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
      const candidateModel = view.model;
      if (!candidateModel) return yield* authenticationError;
      // A credential refresh can wait on a held lock; an unanswered check counts as missing.
      const auth = yield* Effect.tryPromise({
        try: (signal) => view.modelRuntime.getAuth(candidateModel, { signal }),
        catch: () => authenticationError,
      }).pipe(
        Effect.interruptible,
        Effect.timeout("10 seconds"),
        Effect.mapError(() => authenticationError),
      );
      // Pi also resolves AWS credential chains and Vertex ADC without API keys or headers.
      if (!auth) return yield* authenticationError;
      return null;
    });
    const setupError = yield* checkSetup(session).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    );
    // Pi substitutes a placeholder model when none resolves; it is not a model identity.
    const model =
      session.model && session.modelRuntime.getModel(session.model.provider, session.model.id)
        ? { provider: session.model.provider, id: session.model.id }
        : null;
    let restored: typeof Conversation.Type = {
      id: target.manager.getSessionId(),
      sessionFile: target.manager.getSessionFile() ?? target.cwd,
      projectPath: target.cwd,
      modelName: setupError ? "Setup required" : (session.model?.name ?? "Setup required"),
      model,
      setupError,
      status: "idle",
      runId: null,
      messageCount: session.messages.length,
      entries: [],
      error: "",
    };
    // Read the active saved branch, including history before compaction.
    for (const item of target.manager.getBranch()) {
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
            restored = applyConversationUpdate(restored, {
              _tag: "EntryUpserted",
              entry: { id: item.id, role: message.role, text },
            });
          if (message.role === "assistant")
            for (const part of message.content) {
              if (part.type !== "toolCall") continue;
              restored = applyConversationUpdate(restored, {
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
          const entry = restored.entries.find((candidate) => candidate.id === message.toolCallId);
          if (entry?.role === "tool")
            restored = applyConversationUpdate(restored, {
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
    return restored;
  });

  function finishRun(run: Run, messageCount: number) {
    publish({
      _tag: "StateChanged",
      status: "idle",
      runId: null,
      messageCount,
      error: run.conversation.error,
    });
    if (active === run) active = undefined;
  }

  // Run events go to every subscriber, stamped with the run's session; clients keep their own.
  function publish(update: typeof ConversationUpdate.Type) {
    const run = active;
    if (!run) return;
    const stamped =
      update._tag === "Snapshot" || update._tag === "Idle"
        ? update
        : { ...update, sessionId: run.target.sessionId };
    run.conversation = applyConversationUpdate(run.conversation, stamped);
    if (subscribers.size === 0) return;
    const bytes = Buffer.byteLength(JSON.stringify(stamped));
    for (const enqueue of subscribers) enqueue(stamped, bytes);
  }

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
                    // Registration and the initial run state happen together, without a gap.
                    subscribers.add(enqueue);
                    const initial: typeof ConversationUpdate.Type = active
                      ? { _tag: "Snapshot", conversation: active.conversation }
                      : { _tag: "Idle" };
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
          ReadSession: readSession,
          ListSessions: listSessions,
          ListModels: listModels,
          Stop: (payload) => stop(payload).pipe(Effect.uninterruptible),
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
  if (!NetAddress.isInetAddress(server.address)) return yield* new StartupError();
  process.send?.({ port: server.address.port });
  yield* Effect.never;
});

type Located = { cwd: string; manager: SessionManager };

type Run = {
  id: string;
  target: typeof SessionTarget.Type;
  conversation: typeof Conversation.Type;
  session: AgentSession | undefined;
  messageId: string;
  failed: boolean;
  started: Deferred.Deferred<void>;
  finished: Deferred.Deferred<void>;
  stopped: Deferred.Deferred<void, StopError>;
};

function errorCode(cause: unknown) {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function sameSession(a: typeof SessionTarget.Type, b: typeof SessionTarget.Type) {
  return a.projectPath === b.projectPath && a.sessionId === b.sessionId;
}

// Stands in for the run's conversation until its Pi session is open.
function placeholder(target: typeof SessionTarget.Type): typeof Conversation.Type {
  return {
    id: target.sessionId,
    sessionFile: target.sessionFile ?? target.projectPath,
    projectPath: target.projectPath,
    modelName: "",
    model: null,
    setupError: null,
    status: "running",
    runId: null,
    messageCount: 0,
    entries: [],
    error: "",
  };
}

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {}) {}

class OpenError extends Schema.TaggedError<OpenError>()("OpenError", {}) {}

NodeRuntime.runMain(Effect.scoped(program), { disableErrorReporting: true });
