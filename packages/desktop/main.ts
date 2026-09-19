import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Conversation, ConversationApi } from "../api/index.js";
import { Effect, Layer, Schema } from "effect";
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
  const window = yield* Effect.try({
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) =>
    respond(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  const serverSecret = yield* Effect.try({
    try: () => randomBytes(32).toString("hex"),
    catch: () => new DesktopError({ message: "Could not create server credentials" }),
  });
  let server: { child: ChildProcess; port?: number; sessionFile?: string } | undefined;
  let quitting = false;
  const shutdown = Effect.gen(function* () {
    if (quitting) return;
    quitting = true;
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
  ipcMain.handle("choose-project", (event) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== "pidex://app/"
        ) {
          return yield* new DesktopError({ message: "Untrusted window" });
        }
        if (conversation) return conversation;
        if (choosing || quitting) return null;
        choosing = true;
        return yield* Effect.gen(function* () {
          const selection = yield* Effect.tryPromise({
            try: () => dialog.showOpenDialog(window, { properties: ["openDirectory"] }),
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
            const transport = RpcClient.layerProtocolHttp({
              url: `http://127.0.0.1:${ready.port}/rpc`,
              transformClient: HttpClient.mapRequest(
                HttpClientRequest.setHeaders({
                  authorization: `Bearer ${serverSecret}`,
                  origin: "pidex://app",
                }),
              ),
            }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
            conversation = yield* Effect.gen(function* () {
              const client = yield* RpcClient.make(ConversationApi);
              return yield* client.GetConversation();
            }).pipe(
              Effect.provide(transport),
              Effect.scoped,
              Effect.mapError(
                () => new DesktopError({ message: "Could not start the Pi conversation" }),
              ),
            );
            return conversation;
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
  yield* Effect.tryPromise({
    try: () => window.loadURL("pidex://app/"),
    catch: () => new DesktopError({ message: "Could not load the application window" }),
  });
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
