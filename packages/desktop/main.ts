import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Socket } from "effect/socket";
import { NodeSocket } from "@effect/platform-node";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  HistoryError,
  ModelList,
  ModelListError,
  ProjectPath,
  ReadSessionError,
  SessionList,
  SessionLocator,
  SessionTarget,
} from "../api/index.js";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const program = Effect.gen(function* () {
  protocol.registerSchemesAsPrivileged([
    { scheme: "pidex", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  yield* Effect.tryPromise({
    try: () => app.whenReady(),
    catch: () => new DesktopError({ message: "Electron could not start" }),
  });
  protocol.handle("pidex", (request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = yield* Effect.try({
          try: () => {
            const url = new URL(request.url);
            const path = resolve(
              "packages/web/dist",
              `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
            );
            return url.host === "app" && path.startsWith(`${resolve("packages/web/dist")}/`)
              ? path
              : undefined;
          },
          catch: () => new DesktopError({ message: "Invalid application URL" }),
        });
        if (!file) return new Response(null, { status: 403 });
        return yield* Effect.tryPromise({
          try: () => net.fetch(pathToFileURL(file).href),
          catch: () => new DesktopError({ message: "Could not load application content" }),
        });
      }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 404 })))),
    ),
  );
  // Desktop-owned metadata; Pi owns history, so this file never stores transcripts or credentials.
  const metadataFile = join(app.getPath("userData"), "metadata.json");
  let metadataError = "";
  // Preserve unreadable metadata: skip writes until the user repairs it and relaunches.
  let metadataPreserved = false;
  const metadataWrites = yield* Semaphore.make(1);
  let metadata = yield* loadMetadata(metadataFile).pipe(
    Effect.catch((error) =>
      Effect.sync((): typeof Metadata.Type => {
        metadataError = error.message;
        metadataPreserved = true;
        return { version: 1, recentProjects: [] };
      }),
    ),
  );
  let window: BrowserWindow | undefined;
  const serverSecret = yield* Effect.try({
    try: () => randomBytes(32).toString("hex"),
    catch: () => new DesktopError({ message: "Could not create server credentials" }),
  });
  let server: { child: ChildProcess; port?: number } | undefined;
  // Mirrors the renderer's selection for recovery; it belongs to this application lifetime,
  // not to a child or a window. A session draft has no file until its first saved reply.
  let selected: typeof SessionTarget.Type | undefined;
  // Whether a run started in the selected session, so lost first-turn history is detectable.
  let used = false;
  let crashed = false;
  let starting = false;
  let switching = false;
  let interrupted = false;
  let connectionScope: Scope.Closeable | undefined;
  const connections = yield* Scope.make();
  let quitting = false;
  let currentRun: Effect.Effect<string | null, DesktopError> | undefined;
  const shutdown = Effect.gen(function* () {
    if (quitting) return;
    quitting = true;
    // Reconcile with the backend before deciding: the watched state may be behind Send.
    const runId = currentRun
      ? yield* currentRun.pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
    // A lost connection means unknown, even when the last observed state was Idle.
    if (conversation && runId !== null) {
      const confirmation = yield* Effect.tryPromise({
        try: () =>
          dialog.showMessageBox({
            type: "question",
            message: "Stop the current run and quit?",
            detail: "Saved history and file changes will be kept.",
            buttons: ["Cancel", "Quit"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }),
        catch: () => new DesktopError({ message: "Could not confirm Quit" }),
      });
      if (confirmation.response !== 1) {
        quitting = false;
        return;
      }
      // If RPC is lost, SIGTERM below still awaits the backend's Pi finalizer.
      if (stopRun && runId)
        yield* stopRun(runId).pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    }
    yield* Scope.close(connections, Exit.void);
    const child = server?.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      yield* Effect.callback<void, DesktopError>((resume) => {
        const onExit = () => resume(Effect.void);
        child.once("exit", onExit);
        try {
          child.kill("SIGTERM");
        } catch {
          child.off("exit", onExit);
          resume(Effect.fail(new DesktopError({ message: "Could not stop the Pi server" })));
        }
        return Effect.sync(() => {
          child.off("exit", onExit);
        });
      });
    }
    yield* Effect.sync(() => app.quit());
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            quitting = false;
          }),
        ),
      ),
    ),
  );
  app.on("before-quit", (event) => {
    const child = server?.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    event.preventDefault();
    Effect.runFork(shutdown);
  });
  let choosing = false;
  let conversation: typeof Conversation.Type | undefined;
  let connectionError = "";
  let sendPrompt:
    | ((
        target: typeof SessionTarget.Type,
        text: string,
        submissionId?: string,
      ) => Effect.Effect<"accepted" | "uncertain", DesktopError>)
    | undefined;
  let stopRun: ((runId: string) => Effect.Effect<void, DesktopError>) | undefined;
  let listSessions:
    | ((projectPath: string) => Effect.Effect<typeof SessionList.Type, HistoryError>)
    | undefined;
  let listModels:
    | ((target: typeof SessionTarget.Type) => Effect.Effect<typeof ModelList.Type, ModelListError>)
    | undefined;
  let readSession:
    | ((
        target: typeof SessionTarget.Type,
        writable?: boolean,
      ) => Effect.Effect<typeof Conversation.Type, ReadSessionError | DesktopError>)
    | undefined;
  // Reads the renderer's next target and commits it as the selection only after it loads.
  // A new session draft also needs writable history for its first reply.
  const select = Effect.fn(function* (target: typeof SessionTarget.Type, writable = false) {
    if (!readSession) return yield* new DesktopError({ message: "No connected conversation" });
    const next = yield* readSession(target, writable).pipe(
      Effect.mapError((error) => new DesktopError({ message: error.message })),
    );
    selected = target;
    used = false;
    show(next);
    return next;
  });
  const show = (next: typeof Conversation.Type) => {
    conversation = next;
    if (window && !window.isDestroyed())
      window.webContents.send("conversation", { _tag: "Snapshot", conversation: next });
  };
  const busy = () => conversation?.status === "running" || conversation?.status === "stopping";
  ipcMain.handle("new-session", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const target = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ projectPath: ProjectPath, sessionId: Schema.String }),
        )(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid session target" })),
        );
        if (!readSession || !selected || quitting || switching)
          return yield* new DesktopError({ message: "No connected conversation" });
        // Switching projects is a separate operation, restricted to recent projects.
        if (target.projectPath !== selected.projectPath)
          return yield* new DesktopError({ message: "The selected project changed" });
        if (target.sessionId !== selected.sessionId)
          return yield* new DesktopError({
            message: "The selected session changed. Refresh and try again.",
          });
        if (busy())
          return yield* new DesktopError({
            message: "Wait for the current reply or Stop to finish.",
          });
        switching = true;
        // A session draft gets its Pi session from the first Send under this ID.
        yield* select({ projectPath: selected.projectPath, sessionId: randomUUID() }, true).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
      }),
    ),
  );
  ipcMain.handle("switch-project", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const target = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            projectPath: ProjectPath,
            sessionId: SessionLocator.fields.sessionId,
          }),
        )(value).pipe(Effect.mapError(() => new DesktopError({ message: "Invalid project" })));
        // Pi runs tools in the destination, so only Desktop-selected folders are allowed.
        if (!metadata.recentProjects.includes(target.projectPath))
          return yield* new DesktopError({
            message: "Choose this project with the folder picker.",
          });
        if (!readSession || !selected || quitting || switching)
          return yield* new DesktopError({
            message: "Wait for the current session to finish loading, then try again.",
          });
        if (target.sessionId !== selected.sessionId)
          return yield* new DesktopError({
            message: "The selected session changed. Refresh and try again.",
          });
        if (busy())
          return yield* new DesktopError({
            message: "Wait for the current reply or Stop to finish.",
          });
        switching = true;
        yield* select({ projectPath: target.projectPath, sessionId: randomUUID() }, true).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
        yield* rememberProject(target.projectPath);
      }).pipe(
        Effect.match({
          onSuccess: () => ({ error: "" }),
          onFailure: (error) => ({ error: error.message }),
        }),
      ),
    ),
  );
  ipcMain.handle("resume-session", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const locator = yield* Schema.decodeUnknownEffect(SessionLocator)(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid session identity" })),
        );
        if (!readSession || quitting || switching)
          return yield* new DesktopError({ message: "No connected conversation" });
        if (busy())
          return yield* new DesktopError({
            message: "Wait for the current run to finish before resuming a session.",
          });
        const current = selected;
        switching = true;
        return yield* select(locator).pipe(
          Effect.tapError(() =>
            // A selected session whose history became unusable must not accept Send.
            current?.sessionId === locator.sessionId && conversation
              ? Effect.sync(() => {
                  if (!conversation) return;
                  show({
                    ...conversation,
                    status: "unavailable",
                    error:
                      "The active session file is unavailable. Restart the backend before sending.",
                  });
                })
              : Effect.void,
          ),
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
      }).pipe(
        Effect.match({
          onSuccess: (selection) => ({ conversation: selection, error: "", uncertain: false }),
          onFailure: (error) => ({ conversation: null, error: error.message, uncertain: false }),
        }),
      ),
    ),
  );
  ipcMain.handle("list-sessions", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const projectPath = yield* Schema.decodeUnknownEffect(ProjectPath)(value);
        const unavailable = new HistoryError({
          path: projectPath,
          message: "Could not load saved sessions. Check the connection, then Retry.",
        });
        if (!listSessions || quitting) return { projectPath, sessions: [], errors: [unavailable] };
        if (projectPath !== selected?.projectPath)
          return {
            projectPath,
            sessions: [],
            errors: [
              new HistoryError({
                path: projectPath,
                message:
                  "This is not the selected project. Open the project before listing its sessions.",
              }),
            ],
          };
        return yield* listSessions(projectPath).pipe(
          Effect.catch((error) => Effect.succeed({ projectPath, sessions: [], errors: [error] })),
        );
        // Encode tagged errors before Electron's structured clone drops their custom fields.
      }).pipe(Effect.flatMap(Schema.encodeEffect(SessionList))),
    ),
  );
  ipcMain.handle("list-models", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const sessionId = yield* Schema.decodeUnknownEffect(SessionLocator.fields.sessionId)(
          value,
        ).pipe(Effect.mapError(() => new DesktopError({ message: "Invalid session identity" })));
        if (!listModels || !selected || quitting)
          return { list: null, error: "Could not load models. Check the connection, then Retry." };
        if (sessionId !== selected.sessionId)
          return { list: null, error: "The selected session changed. Refresh and try again." };
        return yield* listModels(selected).pipe(
          // Encode tagged errors before Electron's structured clone drops their custom fields.
          Effect.flatMap(Schema.encodeEffect(ModelList)),
          Effect.map((list) => ({ list, error: "" })),
          Effect.catchTag("ModelListError", (error) =>
            Effect.succeed({ list: null, error: error.message }),
          ),
        );
      }),
    ),
  );
  ipcMain.handle("stop-run", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const runId = yield* Schema.decodeUnknownEffect(Schema.String)(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid run identity" })),
        );
        if (!stopRun || quitting)
          return yield* new DesktopError({ message: "No connected conversation" });
        yield* stopRun(runId);
      }),
    ),
  );
  ipcMain.handle("send-prompt", (event, text: unknown, submissionId: unknown, sessionId: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const prompt = yield* Schema.decodeUnknownEffect(Schema.String)(text).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid prompt" })),
        );
        if (!sendPrompt || !selected || quitting || switching)
          return yield* new DesktopError({ message: "Choose a project first" });
        const id = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(
          submissionId,
        ).pipe(Effect.mapError(() => new DesktopError({ message: "Invalid submission ID" })));
        const target = yield* Schema.decodeUnknownEffect(
          Schema.UndefinedOr(SessionLocator.fields.sessionId),
        )(sessionId).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid session identity" })),
        );
        if (target !== undefined && target !== selected.sessionId)
          return yield* new DesktopError({
            message: "The selected session changed. Review it before sending.",
          });
        if (conversation?.status !== "idle")
          return yield* new DesktopError({ message: "Wait for the current reply." });
        return yield* sendPrompt(selected, prompt, id);
      }),
    ),
  );
  ipcMain.handle("recent-projects", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        return { projects: metadata.recentProjects, error: metadataError };
      }),
    ),
  );
  ipcMain.handle("open-project", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const path = yield* Schema.decodeUnknownEffect(ProjectPath)(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid project" })),
        );
        if (!metadata.recentProjects.includes(path))
          return yield* new DesktopError({
            message: "Choose this project with the folder picker.",
          });
        if (conversation) return conversation;
        if (!window || choosing || quitting) return null;
        choosing = true;
        const missing = new DesktopError({
          message: `Could not find ${path}. Restore the folder, then try again. It stays in your recent projects.`,
        });
        return yield* Effect.tryPromise({
          try: () => realpath(path),
          catch: () => missing,
        }).pipe(
          Effect.tap((canonical) =>
            Effect.tryPromise({ try: () => stat(canonical), catch: () => missing }).pipe(
              Effect.filterOrFail(
                (info) => info.isDirectory(),
                () => missing,
              ),
            ),
          ),
          Effect.flatMap(openProject),
          Effect.ensuring(
            Effect.sync(() => {
              choosing = false;
            }),
          ),
        );
      }).pipe(
        Effect.match({
          onSuccess: (opened) => ({ conversation: opened ?? null, error: "" }),
          onFailure: (error) => ({ conversation: null, error: error.message }),
        }),
      ),
    ),
  );
  ipcMain.handle("choose-project", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event)) {
          return yield* new DesktopError({ message: "Untrusted window" });
        }
        if (conversation) return conversation;
        const activeWindow = window;
        if (!activeWindow || choosing || quitting) return null;
        choosing = true;
        return yield* Effect.gen(function* () {
          const selection = yield* Effect.tryPromise({
            try: () => dialog.showOpenDialog(activeWindow, { properties: ["openDirectory"] }),
            catch: () => new DesktopError({ message: "Could not choose a project" }),
          });
          const cwd = selection.filePaths[0];
          if (selection.canceled || !cwd) return null;
          return yield* Effect.tryPromise({
            try: () => realpath(cwd),
            catch: () => new DesktopError({ message: "Could not resolve the project directory" }),
          }).pipe(Effect.flatMap(openProject));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              choosing = false;
            }),
          ),
        );
      }),
    ),
  );
  ipcMain.handle("restart-backend", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        if (
          (!crashed && conversation?.status !== "unavailable") ||
          starting ||
          quitting ||
          !selected
        )
          return;
        const child = server?.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          if (conversation?.status !== "unavailable") return;
          if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
          yield* Effect.callback<void, DesktopError>((resume) => {
            const onExit = () => resume(Effect.void);
            child.once("exit", onExit);
            try {
              child.kill();
            } catch {
              child.off("exit", onExit);
              resume(
                Effect.fail(new DesktopError({ message: "Could not restart the Pi backend" })),
              );
            }
            return Effect.sync(() => child.off("exit", onExit));
          });
        }
        yield* startServer();
      }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error.message })),
    ),
  );
  const openProject = Effect.fn(function* (canonical: string) {
    // Opening a project selects a new session draft there; resuming stays explicit.
    selected = { projectPath: canonical, sessionId: randomUUID() };
    used = false;
    interrupted = false;
    const opened = yield* startServer();
    yield* rememberProject(canonical);
    return opened;
  });
  const rememberProject = Effect.fn(function* (canonical: string) {
    // Update this application lifetime first; persistence may fail or be skipped.
    metadata = {
      version: 1,
      recentProjects: [
        canonical,
        ...metadata.recentProjects.filter((path) => path !== canonical),
      ].slice(0, 10),
    };
    if (metadataPreserved) return;
    // Serialize atomic replacements so an older list never lands last.
    yield* metadataWrites
      .withPermit(Effect.suspend(() => saveMetadata(metadataFile, metadata)))
      .pipe(
        Effect.match({
          onSuccess: () => {
            metadataError = "";
          },
          onFailure: (error) => {
            metadataError = error.message;
          },
        }),
      );
  });
  // Rereads the selection after (re)connecting. Missing history starts a fresh session draft in
  // the same project; unreadable history stops recovery without replacing the file.
  const recover = Effect.fn(function* () {
    const target = selected;
    if (!target || !readSession)
      return yield* new RecoveryFailure({ message: "Could not connect to Pi" });
    const read = readSession;
    const restored = yield* read(target).pipe(
      Effect.catchTag("ReadSessionError", (error) =>
        error.reason === "missing" && error.path !== target.projectPath
          ? Effect.succeed(undefined)
          : Effect.fail(
              new RecoveryFailure({
                message: error.code
                  ? `Cannot read saved history (${error.code}): ${error.path}. Check file and folder permissions, then Restart. The file has not been replaced.`
                  : error.message,
              }),
            ),
      ),
      Effect.mapError((error) =>
        error._tag === "RecoveryFailure" ? error : new RecoveryFailure({ message: error.message }),
      ),
    );
    // A session draft whose first turn never saved has nothing to restore either.
    if (!restored || (used && restored.messageCount === 0)) {
      selected = { projectPath: target.projectPath, sessionId: randomUUID() };
      used = false;
      const fresh = yield* read(selected).pipe(
        Effect.mapError((error) => new RecoveryFailure({ message: error.message })),
      );
      show({
        ...fresh,
        error:
          "Saved history is missing. Started a fresh conversation in the same project; no prompt was replayed.",
      });
      return;
    }
    show(
      interrupted && !restored.error
        ? {
            ...restored,
            error:
              "The previous run was interrupted. Saved history was restored; send a prompt to continue.",
          }
        : restored,
    );
  });
  const startServer = Effect.fn(function* () {
    starting = true;
    connectionError = "";
    return yield* Effect.gen(function* () {
      if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
      const child = yield* Effect.try({
        try: () =>
          fork(fileURLToPath(new URL("../server/main.js", import.meta.url)), [], {
            execArgv: [],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              PIDEX_SERVER_SECRET: serverSecret,
            },
          }),
        catch: () => new DesktopError({ message: "Could not start the Pi conversation" }),
      });
      server = { child };
      child.once("exit", () => {
        if (server?.child !== child) return;
        if (quitting) {
          app.quit();
          return;
        }
        interrupted ||= busy();
        if (!crashed) connectionError = "";
        crashed = true;
        sendPrompt = undefined;
        listSessions = undefined;
        listModels = undefined;
        readSession = undefined;
        stopRun = undefined;
        currentRun = undefined;
        if (window && !window.isDestroyed()) window.webContents.send("backend-crashed");
      });
      return yield* Effect.gen(function* () {
        const ready = yield* Effect.callback<{ port: number }, DesktopError>((resume) => {
          const clear = () => {
            child.off("message", onMessage);
            child.off("error", onFailure);
            child.off("exit", onFailure);
          };
          const onMessage = (message: unknown) => {
            clear();
            resume(
              Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(message).pipe(
                Effect.mapError(() => new DesktopError({ message: "Invalid server response" })),
              ),
            );
          };
          const onFailure = () => {
            clear();
            resume(Effect.fail(new DesktopError({ message: "Server startup failed" })));
          };
          child.once("message", onMessage);
          child.once("error", onFailure);
          child.once("exit", onFailure);
          return Effect.sync(clear);
        });
        server = { child, port: ready.port };
        const scope = yield* Scope.fork(connections, "sequential");
        connectionScope = scope;
        const initial = yield* Deferred.make<typeof Conversation.Type, DesktopError>();
        const connect = Effect.gen(function* () {
          const transport = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
          ).pipe(
            Layer.provide([
              RpcSerialization.layerNdjson,
              Layer.effect(
                Socket.Socket,
                NodeSocket.fromDuplex(
                  Effect.acquireRelease(
                    Effect.sync(() =>
                      NodeSocket.NodeWS.createWebSocketStream(
                        new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${ready.port}/rpc/`, {
                          headers: {
                            authorization: `Bearer ${serverSecret}`,
                            origin: "pidex://app",
                          },
                          handshakeTimeout: 10_000,
                        }),
                      ),
                    ),
                    (stream) =>
                      Effect.sync(() => {
                        stream.destroy();
                      }),
                  ),
                ),
              ),
            ]),
          );
          const socketScope = yield* Effect.scope;
          const context = yield* Layer.buildWithScope(transport, socketScope);
          const client = yield* RpcClient.make(ConversationApi).pipe(
            Effect.provideContext(context),
          );
          listSessions = (projectPath) =>
            client.ListSessions({ projectPath }).pipe(
              Effect.mapError((error) =>
                error._tag === "HistoryError"
                  ? error
                  : new HistoryError({
                      path: projectPath,
                      message: "Could not load saved sessions. Check the connection, then Retry.",
                    }),
              ),
            );
          listModels = (target) =>
            client
              .ListModels({ projectPath: target.projectPath, sessionId: target.sessionId })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "ModelListError"
                    ? error
                    : new ModelListError({
                        message: "Could not load models. Check the connection, then Retry.",
                      }),
                ),
              );
          readSession = (target, writable) =>
            client.ReadSession({ ...target, writable }).pipe(
              Effect.mapError((error) =>
                error._tag === "ReadSessionError"
                  ? error
                  : new DesktopError({
                      message: "Could not load the session. Check the connection, then Retry.",
                    }),
              ),
            );
          stopRun = (runId) =>
            client.Stop({ runId }).pipe(
              Effect.mapError(
                (error) =>
                  new DesktopError({
                    message: error._tag === "StopError" ? error.message : "Could not stop the run",
                  }),
              ),
            );
          sendPrompt = (target, text, submissionId) =>
            client.Send({ target, text, submissionId }).pipe(
              Effect.map((): "accepted" => "accepted"),
              Effect.catchCause((cause) => {
                const failure = Cause.findErrorOption(cause);
                return Option.isSome(failure) && failure.value._tag === "SendError"
                  ? Effect.fail(new DesktopError({ message: failure.value.message }))
                  : Effect.succeed<"uncertain">("uncertain");
              }),
            );
          currentRun = client.Subscribe().pipe(
            Stream.runHead,
            Effect.flatMap((first) =>
              first._tag === "Some" && first.value._tag === "Snapshot"
                ? Effect.succeed(first.value.conversation.runId)
                : first._tag === "Some" && first.value._tag === "Idle"
                  ? Effect.succeed(null)
                  : Effect.fail(new DesktopError({ message: "Could not check the current run" })),
            ),
            Effect.mapError(() => new DesktopError({ message: "Could not check the current run" })),
          );
          let synced = false;
          yield* client.Subscribe().pipe(
            Stream.runForEach((update) =>
              Effect.gen(function* () {
                if (!synced) {
                  // A run may have finished while disconnected; reread the selection first.
                  synced = true;
                  connectionError = "";
                  yield* recover();
                  if (conversation) yield* Deferred.succeed(initial, conversation);
                }
                if (update._tag === "Idle") return;
                if (update._tag === "Snapshot") {
                  // A run for another session is not this window's transcript.
                  if (
                    update.conversation.id !== selected?.sessionId ||
                    update.conversation.projectPath !== selected.projectPath
                  )
                    return;
                  conversation = update.conversation;
                } else if (conversation && update.sessionId === conversation.id) {
                  if (update._tag === "StateChanged" && update.status === "running") used = true;
                  conversation = applyConversationUpdate(conversation, update);
                } else return;
                if (window && !window.isDestroyed())
                  window.webContents.send("conversation", update);
              }),
            ),
          );
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              sendPrompt = undefined;
              listSessions = undefined;
              listModels = undefined;
              readSession = undefined;
              stopRun = undefined;
              currentRun = undefined;
              if (window && !window.isDestroyed()) window.webContents.send("conversation", null);
            }),
          ),
          Effect.retry({
            schedule: Schedule.spaced("500 millis"),
            while: (error) =>
              child.exitCode === null &&
              child.signalCode === null &&
              error._tag !== "RecoveryFailure" &&
              !(error._tag === "SubscribeError" && error.reason === "payload-too-large"),
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (child.exitCode === null && child.signalCode === null) {
                connectionError =
                  error._tag === "RecoveryFailure"
                    ? error.message
                    : "Could not reconnect. Pi history is preserved.";
                if (window && !window.isDestroyed())
                  window.webContents.send("conversation", {
                    _tag: "ConnectionError",
                    message: connectionError,
                  });
                yield* Effect.logError(connectionError);
              }
              yield* Deferred.fail(
                initial,
                new DesktopError({
                  message:
                    error._tag === "RecoveryFailure" ? error.message : "Could not connect to Pi",
                }),
              );
            }),
          ),
        );
        yield* connect.pipe(Effect.forkIn(scope));
        yield* Deferred.await(initial).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        crashed = false;
        interrupted = false;
        return conversation;
      }).pipe(
        Effect.onError(() =>
          Effect.callback<void>((resume) => {
            if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.void);
            const onExit = () => resume(Effect.void);
            child.once("exit", onExit);
            child.kill();
            return Effect.sync(() => {
              child.off("exit", onExit);
            });
          }),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          starting = false;
        }),
      ),
    );
  });
  ipcMain.on("subscribe-conversation", (event) => {
    if (!isTrustedWindow(event)) return;
    // Main owns the live projection. This snapshot and subsequent IPC updates are ordered.
    if (conversation) event.sender.send("conversation", { _tag: "Snapshot", conversation });
    if (connectionError)
      event.sender.send("conversation", { _tag: "ConnectionError", message: connectionError });
    else if (conversation && !sendPrompt) event.sender.send("conversation", null);
    if (crashed) event.sender.send("backend-crashed");
  });
  const openWindow = Effect.fn(function* () {
    if (quitting || (window && !window.isDestroyed())) return;
    const created = yield* Effect.try({
      try: () =>
        new BrowserWindow({
          width: 960,
          height: 720,
          show: process.env.PIDEX_TEST_HEADLESS !== "1",
          backgroundColor: "#101113",
          webPreferences: {
            preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        }),
      catch: () => new DesktopError({ message: "Could not open the application window" }),
    });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) =>
      respond(false),
    );
    created.webContents.session.setPermissionCheckHandler(() => false);
    window = created;
    created.once("closed", () => {
      if (window === created) window = undefined;
    });
    yield* Effect.tryPromise({
      try: () => created.loadURL("pidex://app/"),
      catch: () => new DesktopError({ message: "Could not load the application window" }),
    });
  });
  app.on("window-all-closed", () => {});
  app.on("activate", () => {
    Effect.runFork(openWindow().pipe(Effect.catch((error) => Effect.logError(error.message))));
  });
  yield* openWindow();
  function isTrustedWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
    return (
      window !== undefined &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === "pidex://app/"
    );
  }
});

const Metadata = Schema.Struct({
  version: Schema.Literal(1),
  recentProjects: Schema.Array(ProjectPath),
});
const MetadataFile = Schema.fromJsonString(Metadata, { space: 2 });

const loadMetadata = Effect.fn(function* (file: string) {
  const unreadable = new DesktopError({
    message: `Cannot read Pidex metadata: ${file}. Restore or remove the file, then relaunch. Recent projects are not saved until then; the file has not been changed.`,
  });
  const contents = yield* Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(unreadable),
    ),
  );
  if (contents === undefined)
    return { version: 1, recentProjects: [] } satisfies typeof Metadata.Type;
  return yield* Schema.decodeUnknownEffect(MetadataFile)(contents).pipe(
    Effect.mapError(() => unreadable),
  );
});

// Replace atomically so an interrupted write never leaves partial metadata.
const saveMetadata = Effect.fn(function* (file: string, value: typeof Metadata.Type) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const contents = yield* Schema.encodeEffect(MetadataFile)(value).pipe(
    Effect.mapError(() => new DesktopError({ message: "Could not encode Pidex metadata" })),
  );
  yield* Effect.tryPromise({
    try: async () => {
      await writeFile(temporary, `${contents}\n`, { mode: 0o600 });
      await rename(temporary, file);
    },
    catch: () =>
      new DesktopError({
        message: `Cannot save Pidex metadata: ${file}. Check folder permissions, then relaunch.`,
      }),
  }).pipe(
    Effect.tapError(() => Effect.ignore(Effect.tryPromise(() => rm(temporary, { force: true })))),
  );
});

class RecoveryFailure extends Schema.TaggedError<RecoveryFailure>()("RecoveryFailure", {
  message: Schema.String,
}) {}

class DesktopError extends Schema.TaggedError<DesktopError>()("DesktopError", {
  message: Schema.String,
}) {}

Effect.runFork(
  program.pipe(
    Effect.catch((error) =>
      Effect.logError(error.message).pipe(Effect.andThen(Effect.sync(() => app.exit(1)))),
    ),
  ),
);
