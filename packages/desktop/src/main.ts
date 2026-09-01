import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { healthSchema, safeParse, type PidexApiContractClient } from "@pidex/api";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import path from "node:path";
import { Config, ConfigProvider, Deferred, Duration, Effect, Ref, Schedule, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const { port, webUrl, stateDirectoryOverride } = yield* Config.unwrap({
        port: Config.port("PORT").pipe(Config.withDefault(4783)),
        webUrl: Config.url("PIDEX_WEB_URL").pipe(Config.withDefault(undefined)),
        stateDirectoryOverride: Config.nonEmptyString("PIDEX_STATE_DIR").pipe(
          Config.withDefault(undefined),
        ),
      }).parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));
      if (port < 1024)
        return yield* Effect.fail(
          desktopServerError("PORT must be an integer from 1024 through 65535", port),
        );
      if (webUrl && webUrl.protocol !== "http:" && webUrl.protocol !== "https:")
        return yield* Effect.fail(
          desktopServerError("PIDEX_WEB_URL must be an HTTP or HTTPS URL", webUrl.href),
        );

      const localUrl = `http://127.0.0.1:${port}`;
      const targetUrl = webUrl?.href ?? localUrl;

      yield* Effect.sync(() => app.setName("pidex"));
      yield* Effect.tryPromise({
        try: () => app.whenReady(),
        catch: (cause) => desktopServerError("Electron did not become ready", cause),
      });

      const stateDirectory = stateDirectoryOverride ?? path.join(app.getPath("userData"), "state");
      const quit = yield* Deferred.make<void>();
      yield* registerIpcHandler();
      yield* registerAppLifecycle(quit, targetUrl);

      if (webUrl === undefined) {
        const logs = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* Effect.scoped(spawnServer(stateDirectory, port, logs)).pipe(
          Effect.catch((error) => Effect.logWarning(`${error.message}: ${String(error.cause)}`)),
          Effect.repeat(
            Schedule.exponential("300 millis", 2).pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(5))),
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const apiClient: PidexApiContractClient = createORPCClient(
          new RPCLink({ origin: localUrl, url: "/api/rpc" }),
        );
        const checkServerHealth = Effect.tryPromise({
          try: () => apiClient.system.health({}),
          catch: (cause) => desktopServerError("Pidex could not reach its server", cause),
        }).pipe(
          Effect.flatMap((health) => {
            const result = safeParse(healthSchema, health);
            return result.success
              ? Effect.void
              : Effect.fail(
                  desktopServerError("Pidex received an invalid health response", result.issues),
                );
          }),
        );
        yield* checkServerHealth.pipe(
          Effect.retry({ schedule: Schedule.spaced("125 millis"), times: 79 }),
          Effect.catch((error) =>
            Ref.get(logs).pipe(
              Effect.flatMap((recentLogs) =>
                Effect.fail(
                  desktopServerError(
                    `Pidex server did not become ready. Recent logs:\n${recentLogs.slice(-20).join("\n")}`,
                    error,
                  ),
                ),
              ),
            ),
          ),
        );
      }

      yield* createWindow(targetUrl);
      yield* Deferred.await(quit);
    }),
  ).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => console.error(`Pidex cannot start: ${error.message}`)),
    ),
    Effect.ensuring(Effect.sync(() => app.quit())),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);

interface DesktopServerError {
  readonly _tag: "DesktopServerError";
  readonly message: string;
  readonly cause: unknown;
}

function desktopServerError(message: string, cause: unknown): DesktopServerError {
  return { _tag: "DesktopServerError", message, cause };
}

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

function registerAppLifecycle(quit: Deferred.Deferred<void>, targetUrl: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const onActivate = () => {
        if (BrowserWindow.getAllWindows().length === 0)
          Effect.runFork(
            createWindow(targetUrl).pipe(
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

const createWindow = Effect.fn("desktop.window.create")(function* (targetUrl: string) {
  const window = yield* Effect.try({
    try: () => {
      const trustedOrigin = new URL(targetUrl).origin;
      const created = new BrowserWindow({
        icon: app.isPackaged
          ? path.join(process.resourcesPath, "icon.png")
          : path.resolve(import.meta.dirname, "../assets/icon.png"),
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
    catch: (cause) => desktopServerError("Electron could not create a window", cause),
  });
  yield* Effect.tryPromise({
    try: () => window.loadURL(targetUrl),
    catch: (cause) => desktopServerError("Electron could not load the application", cause),
  });
});

const spawnServer = Effect.fn("desktop.server.spawn")(function* (
  stateDirectory: string,
  port: number,
  logs: Ref.Ref<ReadonlyArray<string>>,
) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const serverDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(repositoryRoot, "packages/server");
  const handle = yield* ChildProcess.make(
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
  ).pipe(
    Effect.mapError((cause) =>
      desktopServerError("Pidex could not start its server process", cause),
    ),
  );
  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      Ref.update(logs, (current) => [...current, line.slice(0, 2000)].slice(-200)),
    ),
    Effect.catch((error) => Effect.logWarning(`Pidex server output stopped: ${String(error)}`)),
    Effect.forkScoped,
  );
  yield* handle.exitCode.pipe(
    Effect.mapError((cause) => desktopServerError("The Pidex server process failed", cause)),
  );
});
