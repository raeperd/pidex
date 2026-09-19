import { Effect, Schema } from "effect";
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
        yield* Effect.tryPromise({
          try: () => dialog.showOpenDialog(window, { properties: ["openDirectory"] }),
          catch: () => new DesktopError({ message: "Could not choose a project" }),
        });
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
