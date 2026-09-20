import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Socket } from "effect/unstable/socket";
import { NodeSocket } from "@effect/platform-node";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { applyConversationUpdate, Conversation, ConversationApi } from "../api/index.js";
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
import { resolve } from "node:path";
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
  let window: BrowserWindow | undefined;
  const serverSecret = yield* Effect.try({
    try: () => randomBytes(32).toString("hex"),
    catch: () => new DesktopError({ message: "Could not create server credentials" }),
  });
  let server: { child: ChildProcess; port?: number; sessionFile?: string } | undefined;
  const connections = yield* Scope.make();
  let quitting = false;
  const shutdown = Effect.gen(function* () {
    if (quitting) return;
    quitting = true;
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
        text: string,
        submissionId?: string,
      ) => Effect.Effect<"accepted" | "uncertain", DesktopError>)
    | undefined;
  ipcMain.handle("send-prompt", (event, text: unknown, submissionId: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!isTrustedWindow(event))
          return yield* new DesktopError({ message: "Untrusted window" });
        const prompt = yield* Schema.decodeUnknownEffect(Schema.String)(text).pipe(
          Effect.mapError(() => new DesktopError({ message: "Invalid prompt" })),
        );
        if (!sendPrompt || quitting)
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
          const child = yield* Effect.try({
            try: () =>
              fork(fileURLToPath(new URL("../server/main.js", import.meta.url)), [], {
                cwd,
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
          return yield* Effect.gen(function* () {
            const ready = yield* Effect.callback<
              { port: number; sessionFile: string },
              DesktopError
            >((resume) => {
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
            });
            server = { child, ...ready };
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
              const connectionScope = yield* Effect.scope;
              const context = yield* Layer.buildWithScope(transport, connectionScope);
              const client = yield* RpcClient.make(ConversationApi).pipe(
                Effect.provideContext(context),
              );
              yield* client.Subscribe().pipe(
                Stream.runForEach((update) =>
                  Effect.gen(function* () {
                    if (update._tag === "Snapshot") {
                      conversation = update.conversation;
                      connectionError = "";
                      sendPrompt = (text, submissionId) =>
                        client.Send({ text, submissionId }).pipe(
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
                  if (window && !window.isDestroyed())
                    window.webContents.send("conversation", null);
                }),
              ),
              Effect.retry({
                schedule: Schedule.spaced("500 millis"),
                while: (error) =>
                  child.exitCode === null &&
                  child.signalCode === null &&
                  !(error._tag === "SubscribeError" && error.reason === "payload-too-large"),
              }),
              Effect.catch(() =>
                Effect.gen(function* () {
                  connectionError = "Could not reconnect. Pi history is preserved.";
                  if (window && !window.isDestroyed())
                    window.webContents.send("conversation", {
                      _tag: "ConnectionError",
                      message: connectionError,
                    });
                  yield* Effect.logError(connectionError);
                  yield* Deferred.fail(
                    initial,
                    new DesktopError({ message: "Could not connect to Pi" }),
                  );
                }),
              ),
            );
            yield* connect.pipe(Effect.forkIn(connections));
            return yield* Deferred.await(initial);
          }).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                server?.child.kill();
              }),
            ),
          );
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
  ipcMain.on("subscribe-conversation", (event) => {
    if (!isTrustedWindow(event)) return;
    // Main owns the live projection. This snapshot and subsequent IPC updates are ordered.
    if (conversation) event.sender.send("conversation", { _tag: "Snapshot", conversation });
    if (connectionError)
      event.sender.send("conversation", { _tag: "ConnectionError", message: connectionError });
    else if (conversation && !sendPrompt) event.sender.send("conversation", null);
  });
  const openWindow = Effect.fn(function* () {
    if (quitting || (window && !window.isDestroyed())) return;
    const created = yield* Effect.try({
      try: () =>
        new BrowserWindow({
          width: 960,
          height: 720,
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
