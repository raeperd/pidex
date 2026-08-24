import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { randomBytes } from "node:crypto";
import { authGrantSchema, healthSchema, safeParse, type PidexApiContractClient } from "@pidex/api";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import path from "node:path";
import { Deferred, Effect, Ref, Stream } from "effect";
import {
  desktopServerError,
  issueAuthGrantForTrustedSender,
  makeAuthenticatedServerCommand,
  superviseServer,
  waitForServer,
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
    const desktopBootstrapCredential = process.env.PIDEX_WEB_URL
      ? (process.env.PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL ?? randomBytes(32).toString("base64url"))
      : randomBytes(32).toString("base64url");
    const targetUrl = process.env.PIDEX_WEB_URL ?? localUrl;
    const openWindow = () => createWindow(targetUrl);
    const quit = yield* Deferred.make<void>();
    yield* registerIpcHandler(new URL(targetUrl).origin, targetUrl, desktopBootstrapCredential);
    yield* registerAppLifecycle(quit, openWindow);

    if (!process.env.PIDEX_WEB_URL) {
      const logs = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* superviseServer(spawnServer(stateDirectory, desktopBootstrapCredential, logs)).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* waitForServer(checkServerHealth, Ref.get(logs));
    }

    yield* openWindow();
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

function registerIpcHandler(
  trustedOrigin: string,
  targetUrl: string,
  desktopBootstrapCredential: string,
) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.handle("pidex:pick-project", async (event) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner || !isTrustedSender(event, trustedOrigin)) return null;
        const result = await dialog.showOpenDialog(owner, {
          title: "Open a project in Pidex",
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
      ipcMain.handle("pidex:take-auth-grant", (event) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        return issueAuthGrantForTrustedSender(
          Boolean(owner && isTrustedSender(event, trustedOrigin)),
          () => Effect.runPromise(requestDesktopGrant(targetUrl, desktopBootstrapCredential)),
        );
      });
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeHandler("pidex:pick-project");
        ipcMain.removeHandler("pidex:take-auth-grant");
      }),
  );
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent, trustedOrigin: string) {
  const frame = event.senderFrame;
  return Boolean(frame && URL.parse(frame.url)?.origin === trustedOrigin);
}

function registerAppLifecycle(
  quit: Deferred.Deferred<void>,
  openWindow: () => Effect.Effect<void, ReturnType<typeof desktopServerError>>,
) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const onActivate = () => {
        if (BrowserWindow.getAllWindows().length === 0)
          Effect.runFork(
            openWindow().pipe(
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
  desktopBootstrapCredential: string,
  logs: Ref.Ref<ReadonlyArray<string>>,
) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const serverDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(repositoryRoot, "apps/server");
  const command = makeAuthenticatedServerCommand(
    process.execPath,
    [path.join(serverDirectory, "dist/main.js")],
    desktopBootstrapCredential,
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

const requestDesktopGrant = Effect.fn("desktop.auth.createGrant")(function* (
  targetUrl: string,
  desktopBootstrapCredential: string,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${targetUrl}/api/auth/desktop-grant`, {
        method: "POST",
        headers: { authorization: `Bearer ${desktopBootstrapCredential}` },
      }),
    catch: (cause) =>
      desktopServerError("auth.desktopGrant", "Pidex could not request a window grant", cause),
  });
  if (!response.ok)
    return yield* Effect.fail(
      desktopServerError(
        "auth.desktopGrant",
        `Pidex rejected a window grant with HTTP ${response.status}`,
        response.status,
      ),
    );
  const body: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      desktopServerError("auth.desktopGrant", "Pidex returned an invalid window grant", cause),
  });
  const result = safeParse(authGrantSchema, body);
  if (!result.success)
    return yield* Effect.fail(
      desktopServerError("auth.desktopGrant", "Pidex returned an invalid window grant", body),
    );
  return result.output.secret;
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
