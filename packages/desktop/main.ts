import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Socket } from "effect/unstable/socket";
import { NodeSocket } from "@effect/platform-node";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
  applyConversationUpdate,
  Conversation,
  ConversationApi,
  HistoryError,
  ProjectPath,
  RecentProjects,
  SessionList,
  SessionLocator,
} from "../api/index.js";
import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
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
  Stream,
} from "effect";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const program = Effect.gen(function* () {
  protocol.registerSchemesAsPrivileged([
    { scheme: "pidex", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
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
  let window: BrowserWindow | undefined;
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) window.focus();
  });
  const serverSecret = yield* Effect.try({
    try: () => randomBytes(32).toString("hex"),
    catch: () => new DesktopError({ message: "Could not create server credentials" }),
  });
  let server: { child: ChildProcess; port?: number } | undefined;
  // Recovery belongs to this application lifetime, not to a child or a window.
  let project: string | undefined;
  let sessionFile: string | undefined;
  let crashed = false;
  let starting = false;
  let switching = false;
  let pendingResume: typeof SessionLocator.Type | undefined;
  let pendingSwitch: string | undefined;
  let pendingSwitchLocator: typeof SessionLocator.Type | undefined;
  // Shared by the RPC result and subscription reconciliation in this application lifetime.
  // oxlint-disable-next-line consistent-function-scoping
  const matchesResume = (
    selected: typeof Conversation.Type | undefined,
    locator: typeof SessionLocator.Type,
  ) =>
    selected?.id === locator.sessionId &&
    selected.projectPath === locator.projectPath &&
    selected.sessionFile === locator.sessionFile &&
    selected.status !== "unavailable";
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
  let pickedProject: string | undefined;
  const metadataPath = join(app.getPath("userData"), "metadata.json");
  const Metadata = Schema.Struct({
    version: Schema.Literal(1),
    recentProjects: Schema.Array(ProjectPath),
    sessionDrafts: Schema.optional(Schema.Unknown),
  });
  const loadMetadata = Effect.fn(function* () {
    const contents = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(metadataPath, "utf8");
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
          throw cause;
        }
      },
      catch: () =>
        new DesktopError({
          message: `Could not read recent projects at ${metadataPath}. Check file permissions and Retry.`,
        }),
    });
    if (contents === null) {
      const recentProjects: string[] = [];
      return { version: 1, recentProjects };
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(contents),
      catch: () =>
        new DesktopError({
          message: `Recent projects metadata at ${metadataPath} is unreadable. Restore the file and Retry.`,
        }),
    });
    return yield* Schema.decodeUnknownEffect(Metadata)(parsed).pipe(
      Effect.mapError(
        () =>
          new DesktopError({
            message: `Recent projects metadata at ${metadataPath} is unreadable. Restore the file and Retry.`,
          }),
      ),
    );
  });
  const rememberProject = Effect.fn(function* (canonical: string) {
    const metadata = yield* loadMetadata();
    const recentProjects = [canonical];
    const seen = new Set(recentProjects);
    for (const path of metadata.recentProjects) {
      const resolved = yield* Effect.tryPromise({
        try: () => realpath(path),
        catch: () => new DesktopError({ message: `Could not resolve ${path}` }),
      }).pipe(Effect.catch(() => Effect.succeed(path)));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      recentProjects.push(resolved);
    }
    const next = {
      ...metadata,
      recentProjects,
    };
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, metadataPath);
      },
      catch: () =>
        new DesktopError({
          message: "Could not save recent projects. Check storage permissions and Retry.",
        }),
    }).pipe(Effect.ensuring(Effect.promise(() => unlink(temporary).catch(() => {}))));
  });
  const openProject = Effect.fn(function* (cwd: string) {
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(cwd),
      catch: () =>
        new DesktopError({
          message: `Could not open ${cwd}. Check that the folder exists and is accessible, or Choose another folder.`,
        }),
    });
    yield* rememberProject(canonical);
    project = canonical;
    sessionFile = undefined;
    interrupted = false;
    return yield* startServer();
  });
  let conversation: typeof Conversation.Type | undefined;
  let connectionError = "";
  let sendPrompt:
    | ((
        text: string,
        submissionId?: string,
      ) => Effect.Effect<"accepted" | "uncertain", DesktopError>)
    | undefined;
  let stopRun: ((runId: string) => Effect.Effect<void, DesktopError>) | undefined;
  let listSessions:
    | ((projectPath: string) => Effect.Effect<typeof SessionList.Type, HistoryError>)
    | undefined;
  let startNewSession:
    | ((projectPath: string, sessionId: string) => Effect.Effect<string, DesktopError>)
    | undefined;
  let resumeSession:
    | ((
        locator: typeof SessionLocator.Type,
      ) => Effect.Effect<typeof Conversation.Type | "uncertain", DesktopError>)
    | undefined;
  let switchProject:
    | ((
        projectPath: string,
        currentProjectPath: string,
        currentSessionId: string,
      ) => Effect.Effect<typeof Conversation.Type | "uncertain", DesktopError>)
    | undefined;
  ipcMain.handle("switch-project", (event, value: unknown) =>
    Effect.runPromise(
      // Validate, serialize, and reconcile the selected project at this IPC boundary.
      // oxlint-disable-next-line complexity
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const target = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            projectPath: ProjectPath,
            currentProjectPath: ProjectPath,
            currentSessionId: SessionLocator.fields.sessionId,
          }),
        )(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid project target" })),
        );
        if (!switchProject || quitting || switching || pendingResume || !conversation)
          return yield* new DesktopError({ message: "Project selection is unavailable" });
        if (pendingSwitch && pendingSwitch !== target.projectPath)
          return yield* new DesktopError({
            message: "Resolve the pending switch before selecting another project.",
          });
        if (pickedProject !== target.projectPath) {
          const metadata = yield* loadMetadata();
          if (!metadata.recentProjects.includes(target.projectPath))
            return yield* new DesktopError({
              message: "Choose this folder or select it from recent projects first.",
            });
        }
        const retrying = pendingSwitch !== undefined;
        if (
          retrying &&
          conversation.projectPath === target.projectPath &&
          conversation.status === "idle"
        ) {
          pendingSwitch = undefined;
          return { conversation, error: "", uncertain: false };
        }
        if (
          conversation.projectPath !== target.currentProjectPath ||
          conversation.id !== target.currentSessionId
        )
          return yield* new DesktopError({
            message: "The selected session changed. Refresh and try again.",
          });
        switching = true;
        pendingSwitch = target.projectPath;
        const selected = yield* switchProject(
          target.projectPath,
          target.currentProjectPath,
          target.currentSessionId,
        ).pipe(
          Effect.catch((error) =>
            retrying ? Effect.succeed<"uncertain">("uncertain") : Effect.fail(error),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingSwitch = undefined;
              pendingSwitchLocator = undefined;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
        if (selected === "uncertain" && conversation?.projectPath !== target.projectPath)
          return {
            conversation: null,
            error: "Switch result is uncertain. Wait for reconnect or Retry before sending.",
            uncertain: true,
          };
        const current = selected === "uncertain" ? conversation : selected;
        if (!current || current.status === "unavailable")
          return {
            conversation: null,
            error: "Switch did not finish. Restart the backend before sending.",
            uncertain: true,
          };
        pendingSwitch = undefined;
        pendingSwitchLocator = undefined;
        pickedProject = undefined;
        project = current.projectPath;
        sessionFile = current.sessionFile;
        yield* rememberProject(current.projectPath);
        return { conversation: current, error: "", uncertain: false };
      }).pipe(
        Effect.match({
          onSuccess: (result) => result,
          onFailure: (error) => ({ conversation: null, error: error.message, uncertain: false }),
        }),
      ),
    ),
  );
  ipcMain.handle("pick-project", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const activeWindow = window;
        if (!activeWindow || quitting || switching || choosing) return null;
        const selection = yield* Effect.tryPromise({
          try: () => dialog.showOpenDialog(activeWindow, { properties: ["openDirectory"] }),
          catch: () => new DesktopError({ message: "Could not choose a project" }),
        });
        const path = selection.filePaths[0];
        if (selection.canceled || !path) return null;
        pickedProject = yield* Effect.tryPromise({
          try: () => realpath(path),
          catch: () =>
            new DesktopError({
              message: "Could not open that folder. Check its location and Retry.",
            }),
        });
        return pickedProject;
      }),
    ),
  );
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
        if (!startNewSession || quitting || switching || pendingResume || pendingSwitch)
          return yield* new DesktopError({ message: "No connected conversation" });
        switching = true;
        yield* startNewSession(target.projectPath, target.sessionId).pipe(
          Effect.tap((path) =>
            Effect.sync(() => {
              sessionFile = path;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
      }),
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
        if (!resumeSession || quitting || switching || pendingSwitch)
          return yield* new DesktopError({ message: "No connected conversation" });
        if (
          pendingResume &&
          (pendingResume.projectPath !== locator.projectPath ||
            pendingResume.sessionId !== locator.sessionId ||
            pendingResume.sessionFile !== locator.sessionFile)
        )
          return yield* new DesktopError({
            message: "Resolve the pending resume before selecting another session.",
          });
        const retrying = pendingResume !== undefined;
        pendingResume = locator;
        switching = true;
        const selected = yield* resumeSession(locator).pipe(
          Effect.catch((error) =>
            retrying ? Effect.succeed<"uncertain">("uncertain") : Effect.fail(error),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingResume = undefined;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        );
        if (selected === "uncertain" && !matchesResume(conversation, locator))
          return {
            conversation: null,
            error: "Resume result is uncertain. Wait for reconnect or Retry before sending.",
            uncertain: true,
          };
        pendingResume = undefined;
        sessionFile = locator.sessionFile;
        return {
          conversation: selected === "uncertain" ? (conversation ?? null) : selected,
          error: "",
          uncertain: false,
        };
      }).pipe(
        Effect.match({
          onSuccess: (result) => result,
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
        return yield* listSessions(projectPath).pipe(
          Effect.catch((error) => Effect.succeed({ projectPath, sessions: [], errors: [error] })),
        );
        // Encode tagged errors before Electron's structured clone drops their custom fields.
      }).pipe(Effect.flatMap(Schema.encodeEffect(SessionList))),
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
  ipcMain.handle("send-prompt", (event, text: unknown, submissionId: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const prompt = yield* Schema.decodeUnknownEffect(Schema.String)(text).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid prompt" })),
        );
        if (!sendPrompt || quitting || switching || pendingResume || pendingSwitch)
          return yield* new DesktopError({ message: "Choose a project first" });
        const id = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(
          submissionId,
        ).pipe(Effect.mapError(() => new DesktopError({ message: "Invalid submission ID" })));
        return yield* sendPrompt(prompt, id);
      }),
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
          return yield* openProject(cwd);
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
  ipcMain.handle("recent-projects", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        return yield* loadMetadata().pipe(
          Effect.map((metadata) => ({ projects: metadata.recentProjects, error: "" })),
          Effect.catch((error) => Effect.succeed({ projects: [], error: error.message })),
        );
      }).pipe(Effect.flatMap(Schema.encodeEffect(RecentProjects))),
    ),
  );
  ipcMain.handle("open-recent-project", (event, value: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const path = yield* Schema.decodeUnknownEffect(ProjectPath)(value).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid project path" })),
        );
        if (conversation || choosing || quitting || switching || pendingSwitch)
          return yield* new DesktopError({ message: "Project selection is unavailable" });
        const metadata = yield* loadMetadata();
        if (!metadata.recentProjects.includes(path))
          return yield* new DesktopError({ message: "Project is not in recent projects" });
        choosing = true;
        return yield* openProject(path).pipe(
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
          (!crashed &&
            conversation?.status !== "unavailable" &&
            !pendingResume &&
            !pendingSwitch) ||
          starting ||
          quitting ||
          !project
        )
          return;
        const child = server?.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          if (conversation?.status !== "unavailable" && !pendingResume && !pendingSwitch) return;
          if (pendingResume) sessionFile = undefined;
          yield* Effect.callback<void, DesktopError>((resume) => {
            const onExit = () => {
              clearTimeout(forceExit);
              resume(Effect.void);
            };
            const forceExit = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 5000);
            child.once("exit", onExit);
            try {
              child.kill();
            } catch {
              clearTimeout(forceExit);
              child.off("exit", onExit);
              resume(
                Effect.fail(new DesktopError({ message: "Could not restart the Pi backend" })),
              );
            }
            return Effect.sync(() => {
              clearTimeout(forceExit);
              child.off("exit", onExit);
            });
          });
        }
        pendingResume = undefined;
        pendingSwitch = undefined;
        pendingSwitchLocator = undefined;
        yield* startServer();
      }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error.message })),
    ),
  );
  const startServer = Effect.fn(function* () {
    starting = true;
    connectionError = "";
    return yield* Effect.gen(function* () {
      if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
      const child = yield* Effect.try({
        try: () =>
          fork(fileURLToPath(new URL("../server/main.js", import.meta.url)), [], {
            cwd: project,
            execArgv: [],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              PIDEX_SERVER_SECRET: serverSecret,
              PIDEX_SESSION_FILE: sessionFile ?? "",
              PIDEX_INTERRUPTED: interrupted ? "1" : "",
            },
          }),
        catch: () => new DesktopError({ message: "Could not start the Pi conversation" }),
      });
      server = { child };
      child.on("message", (message: unknown) => {
        const decoded = Schema.decodeUnknownExit(
          Schema.Struct({
            type: Schema.Literal("session-locator"),
            sessionId: Schema.String,
            sessionFile: ProjectPath,
            projectPath: Schema.optional(ProjectPath),
          }),
        )(message);
        if (Exit.isFailure(decoded) || server?.child !== child) return;
        if (
          pendingResume &&
          (pendingResume.sessionId !== decoded.value.sessionId ||
            pendingResume.sessionFile !== decoded.value.sessionFile)
        )
          return;
        if (pendingSwitch) {
          if (decoded.value.projectPath !== pendingSwitch) return;
          pendingSwitchLocator = {
            projectPath: pendingSwitch,
            sessionId: decoded.value.sessionId,
            sessionFile: decoded.value.sessionFile,
          };
        } else if (!decoded.value.projectPath || decoded.value.projectPath === project)
          sessionFile = decoded.value.sessionFile;
        if (child.connected)
          child.send({ type: "session-locator-ack", sessionId: decoded.value.sessionId }, () => {
            // A closed channel leaves the backend waiting for the acknowledgment timeout.
          });
      });
      child.once("exit", () => {
        if (server?.child !== child) return;
        if (quitting) {
          app.quit();
          return;
        }
        interrupted ||= conversation !== undefined && conversation.status !== "idle";
        if (!crashed) connectionError = "";
        crashed = true;
        if (pendingResume) sessionFile = undefined;
        sendPrompt = undefined;
        listSessions = undefined;
        startNewSession = undefined;
        resumeSession = undefined;
        switchProject = undefined;
        stopRun = undefined;
        currentRun = undefined;
        if (window && !window.isDestroyed()) window.webContents.send("backend-crashed");
      });
      return yield* Effect.gen(function* () {
        const ready = yield* Effect.callback<{ port: number; sessionFile: string }, DesktopError>(
          (resume) => {
            const clear = () => {
              child.off("message", onMessage);
              child.off("error", onFailure);
              child.off("exit", onFailure);
            };
            const onMessage = (message: unknown) => {
              clear();
              resume(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ port: Schema.Number, sessionFile: Schema.String }),
                )(message).pipe(
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
          },
        );
        server = { child, port: ready.port };
        sessionFile = ready.sessionFile;
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
          startNewSession = (projectPath, sessionId) =>
            client.NewSession({ projectPath, sessionId }).pipe(
              Effect.map(({ sessionFile: path }) => path),
              Effect.mapError(
                (error) =>
                  new DesktopError({
                    message:
                      error._tag === "NewSessionError"
                        ? error.message
                        : "Could not start a new session. Retry.",
                  }),
              ),
            );
          resumeSession = (locator) =>
            client.ResumeSession(locator).pipe(
              Effect.catchCause((cause) => {
                const failure = Cause.findErrorOption(cause);
                return Option.isSome(failure) && failure.value._tag === "ResumeError"
                  ? Effect.fail(new DesktopError({ message: failure.value.message }))
                  : Effect.succeed<"uncertain">("uncertain");
              }),
            );
          switchProject = (projectPath, currentProjectPath, currentSessionId) =>
            client.SwitchProject({ projectPath, currentProjectPath, currentSessionId }).pipe(
              Effect.catchCause((cause) => {
                const failure = Cause.findErrorOption(cause);
                return Option.isSome(failure) && failure.value._tag === "SwitchError"
                  ? Effect.fail(new DesktopError({ message: failure.value.message }))
                  : Effect.succeed<"uncertain">("uncertain");
              }),
            );
          yield* client.Subscribe().pipe(
            Stream.runForEach((update) =>
              Effect.gen(function* () {
                if (update._tag === "Snapshot") {
                  conversation = update.conversation;
                  if (pendingResume) {
                    if (matchesResume(update.conversation, pendingResume)) {
                      sessionFile = pendingResume.sessionFile;
                      pendingResume = undefined;
                    }
                  } else if (
                    !pendingSwitch &&
                    update.conversation.status !== "unavailable" &&
                    update.conversation.projectPath === project
                  )
                    sessionFile = update.conversation.sessionFile;
                  if (
                    pendingSwitch &&
                    pendingSwitchLocator &&
                    matchesResume(update.conversation, pendingSwitchLocator)
                  ) {
                    project = pendingSwitchLocator.projectPath;
                    sessionFile = pendingSwitchLocator.sessionFile;
                    pendingSwitch = undefined;
                    pendingSwitchLocator = undefined;
                  }
                  connectionError = "";
                  currentRun = client.Subscribe().pipe(
                    Stream.runHead,
                    Effect.flatMap((first) =>
                      first._tag === "Some" && first.value._tag === "Snapshot"
                        ? Effect.succeed(first.value.conversation.runId)
                        : Effect.fail(
                            new DesktopError({ message: "Could not check the current run" }),
                          ),
                    ),
                    Effect.mapError(
                      () => new DesktopError({ message: "Could not check the current run" }),
                    ),
                  );
                  stopRun = (runId) =>
                    client.Stop({ runId }).pipe(
                      Effect.mapError(
                        (error) =>
                          new DesktopError({
                            message:
                              error._tag === "StopError" ? error.message : "Could not stop the run",
                          }),
                      ),
                    );
                  sendPrompt = (text, submissionId) =>
                    client
                      .Send({
                        projectPath: update.conversation.projectPath,
                        sessionId: update.conversation.id,
                        text,
                        submissionId,
                      })
                      .pipe(
                        Effect.map((): "accepted" => "accepted"),
                        Effect.catchCause((cause) => {
                          const failure = Cause.findErrorOption(cause);
                          return Option.isSome(failure) && failure.value._tag === "SendError"
                            ? Effect.fail(new DesktopError({ message: failure.value.message }))
                            : Effect.succeed<"uncertain">("uncertain");
                        }),
                      );
                } else if (conversation)
                  conversation = applyConversationUpdate(conversation, update);
                if (window && !window.isDestroyed())
                  window.webContents.send("conversation", update);
                if (conversation) yield* Deferred.succeed(initial, conversation);
              }),
            ),
          );
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              sendPrompt = undefined;
              listSessions = undefined;
              startNewSession = undefined;
              resumeSession = undefined;
              switchProject = undefined;
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
              error._tag !== "RecoveryError" &&
              !(error._tag === "SubscribeError" && error.reason === "payload-too-large"),
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (child.exitCode === null && child.signalCode === null) {
                connectionError =
                  error._tag === "RecoveryError"
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
                    error._tag === "RecoveryError" ? error.message : "Could not connect to Pi",
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
