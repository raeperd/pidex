import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { healthSchema, type PidexApiContractClient } from "@pidex/api";
import { NodeRuntime } from "@effect/platform-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Deferred, Effect, Ref } from "effect";
import {
  desktopServerError,
  superviseServer,
  waitForServer,
  type DesktopServerError,
  type ServerProcess,
} from "./server-lifecycle.js";

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
    Effect.sync(() => {
      console.error(`Pidex cannot start: ${error.message}`);
      app.quit();
    }),
  ),
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
      const onBeforeQuit = () => {
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
        backgroundColor: "#181b18",
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

function spawnServer(
  stateDirectory: string,
  logs: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<ServerProcess, DesktopServerError> {
  return Effect.try({
    try: () => {
      const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
      const serverDirectory = app.isPackaged
        ? path.join(process.resourcesPath, "server")
        : path.join(repositoryRoot, "apps/server");
      const child = spawn(process.execPath, [path.join(serverDirectory, "dist/main.js")], {
        cwd: app.isPackaged ? process.resourcesPath : repositoryRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PIDEX_STATE_DIR: stateDirectory,
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onData = (chunk: Buffer) => Effect.runFork(remember(logs, chunk));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      return { child, onData };
    },
    catch: (cause) =>
      desktopServerError("server.spawn", "Pidex could not start its server process", cause),
  }).pipe(
    Effect.map(({ child, onData }) => ({
      exited: awaitExit(child),
      stop: stopServer(child, onData),
    })),
  );
}

function awaitExit(child: ChildProcess): Effect.Effect<void, DesktopServerError> {
  if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
  return Effect.callback((resume) => {
    const onExit = () => resume(Effect.void);
    const onError = (cause: Error) =>
      resume(
        Effect.fail(desktopServerError("server.process", "The Pidex server process failed", cause)),
      );
    child.once("exit", onExit);
    child.once("error", onError);
    return Effect.sync(() => {
      child.off("exit", onExit);
      child.off("error", onError);
    });
  });
}

function stopServer(child: ChildProcess, onData: (chunk: Buffer) => void) {
  return Effect.try(() => {
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }).pipe(Effect.catch(() => Effect.void));
}

function remember(logs: Ref.Ref<ReadonlyArray<string>>, chunk: Buffer) {
  const lines = chunk
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, 2000));
  return Ref.update(logs, (current) => [...current, ...lines].slice(-200));
}

const checkServerHealth = Effect.tryPromise({
  try: () => apiClient.system.health({}),
  catch: (cause) => desktopServerError("server.health", "Pidex could not reach its server", cause),
}).pipe(
  Effect.flatMap((health) => {
    const result = healthSchema.safeParse(health);
    return result.success
      ? Effect.void
      : Effect.fail(
          desktopServerError(
            "server.health",
            "Pidex received an invalid health response",
            result.error,
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
