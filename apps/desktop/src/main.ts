import { app, BrowserWindow } from "electron";
import path from "node:path";

const createWindow = (): void => {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const developmentUrl = process.env.PIDEX_WEB_URL;

  if (developmentUrl) {
    void window.loadURL(developmentUrl);
    return;
  }

  void window.loadFile(path.resolve(import.meta.dirname, "../../web/dist/index.html"));
};

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
