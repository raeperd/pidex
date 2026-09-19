import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

protocol.registerSchemesAsPrivileged([
  { scheme: "pidex", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
void app.whenReady().then(async () => {
  protocol.handle("pidex", (request) => {
    const url = new URL(request.url);
    const file = resolve(
      "packages/web/dist",
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (url.host !== "app" || !file.startsWith(`${resolve("packages/web/dist")}/`)) {
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(file).href);
  });
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) =>
    respond(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  ipcMain.handle("choose-project", async (event) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== "pidex://app/"
    ) {
      throw new Error("Untrusted window");
    }
    await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  });
  await window.loadURL("pidex://app/");
});
