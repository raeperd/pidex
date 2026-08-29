import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { healthSchema, safeParse, type PidexApiContractClient } from "@pidex/api";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import path from "node:path";
import { Deferred, Effect, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { desktopServerError, superviseServer, waitForServer } from "./server-lifecycle.js";

const main = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.sync(() => app.setName("pidex"));
    yield* Effect.tryPromise({
      try: () => app.whenReady(),
      catch: (cause) =>
        desktopServerError("electron.ready", "Electron did not become ready", cause),
    });

    const stateDirectory =
      process.env.PIDEX_STATE_DIR ?? path.join(app.getPath("userData"), "state");
    const quit = yield* Deferred.make<void>();
    yield* registerIpcHandler();
    yield* registerAppLifecycle(quit);

    if (!process.env.PIDEX_WEB_URL) {
      const logs = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* superviseServer(spawnServer(stateDirectory, logs)).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* waitForServer(checkServerHealth, Ref.get(logs));
    }

    yield* createWindow();
    yield* Deferred.await(quit);
  }),
).pipe(
  Effect.tapError((error) =>
    Effect.sync(() => console.error(`Pidex cannot start: ${error.message}`)),
  ),
  Effect.ensuring(Effect.sync(() => app.quit())),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });

function registerIpcHandler() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.handle("pidex:pick-project", async (event) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) return null;
        const result = await dialog.showOpenDialog(owner, {
          title: "Open a project in Pidex",
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
    }),
    () => Effect.sync(() => ipcMain.removeHandler("pidex:pick-project")),
  );
}

function registerAppLifecycle(quit: Deferred.Deferred<void>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const onActivate = () => {
        if (BrowserWindow.getAllWindows().length === 0)
          Effect.runFork(
            createWindow().pipe(
              Effect.catch((error) =>
                Effect.sync(() => console.error(`Pidex cannot create a window: ${error.message}`)),
              ),
            ),
          );
      };
      const onBeforeQuit = (event: Electron.Event) => {
        event.preventDefault();
        Effect.runFork(Deferred.succeed(quit, undefined));
      };
      app.on("activate", onActivate);
      app.on("before-quit", onBeforeQuit);
      app.on("window-all-closed", quitWhenWindowsClose);
      return { onActivate, onBeforeQuit };
    }),
    ({ onActivate, onBeforeQuit }) =>
      Effect.sync(() => {
        app.off("activate", onActivate);
        app.off("before-quit", onBeforeQuit);
        app.off("window-all-closed", quitWhenWindowsClose);
      }),
  );
}

function quitWhenWindowsClose() {
  if (process.platform !== "darwin") app.quit();
}

const createWindow = Effect.fn("desktop.window.create")(function* () {
  const targetUrl = process.env.PIDEX_WEB_URL ?? localUrl;
  const window = yield* Effect.try({
    try: () => {
      const trustedOrigin = new URL(targetUrl).origin;
      const created = new BrowserWindow({
        icon: appIconPath,
        width: 1280,
        height: 820,
        minWidth: 320,
        minHeight: 560,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#fafafa",
        ...(process.platform === "darwin"
          ? {
              titleBarStyle: "hiddenInset",
              trafficLightPosition: { x: 16, y: 18 },
            }
          : {}),
        webPreferences: {
          preload: path.join(import.meta.dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event, url) => {
        if (URL.parse(url)?.origin !== trustedOrigin) event.preventDefault();
      });
      return created;
    },
    catch: (cause) =>
      desktopServerError("electron.window.create", "Electron could not create a window", cause),
  });
  yield* Effect.tryPromise({
    try: () => window.loadURL(targetUrl),
    catch: (cause) =>
      desktopServerError("electron.window.load", "Electron could not load the application", cause),
  });
});

const spawnServer = Effect.fn("desktop.server.spawn")(function* (
  stateDirectory: string,
  logs: Ref.Ref<ReadonlyArray<string>>,
) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const serverDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(repositoryRoot, "packages/server");
  const command = ChildProcess.make(
    process.execPath,
    [path.join(serverDirectory, "dist/main.js")],
    {
      cwd: app.isPackaged ? process.resourcesPath : repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PIDEX_STATE_DIR: stateDirectory,
        PORT: String(port),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "5 seconds",
    },
  );
  const handle = yield* command.pipe(
    Effect.mapError((cause) =>
      desktopServerError("server.spawn", "Pidex could not start its server process", cause),
    ),
  );
  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) => remember(logs, line)),
    Effect.catch((error) => Effect.logWarning(`Pidex server output stopped: ${String(error)}`)),
    Effect.forkScoped,
  );
  yield* handle.exitCode.pipe(
    Effect.mapError((cause) =>
      desktopServerError("server.process", "The Pidex server process failed", cause),
    ),
  );
});

function remember(logs: Ref.Ref<ReadonlyArray<string>>, line: string) {
  return Ref.update(logs, (current) => [...current, line.slice(0, 2000)].slice(-200));
}

const checkServerHealth = Effect.tryPromise({
  try: () => apiClient.system.health({}),
  catch: (cause) => desktopServerError("server.health", "Pidex could not reach its server", cause),
}).pipe(
  Effect.flatMap((health) => {
    const result = safeParse(healthSchema, health);
    return result.success
      ? Effect.void
      : Effect.fail(
          desktopServerError(
            "server.health",
            "Pidex received an invalid health response",
            result.issues,
          ),
        );
  }),
);

const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.resolve(import.meta.dirname, "../assets/icon.png");
const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : 4783;
const localUrl = `http://127.0.0.1:${port}`;
const apiClient: PidexApiContractClient = createORPCClient(
  new RPCLink({ origin: localUrl, url: "/api/rpc" }),
);
