import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { healthSchema } from "@pidex/api";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const appIconPath = path.resolve(import.meta.dirname, "../assets/icon.png");
const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : 4783;
const localUrl = `http://127.0.0.1:${port}`;
let serverChild: ChildProcess | undefined;
let quitting = false;
let restartCount = 0;
const logs: string[] = [];
const remember = (chunk: Buffer) => {
  for (const line of chunk.toString("utf8").split("\n").filter(Boolean))
    logs.push(line.slice(0, 2000));
  if (logs.length > 200) logs.splice(0, logs.length - 200);
};

function spawnServer() {
  if (process.env.PIDEX_WEB_URL || quitting) return;
  const entry = path.resolve(import.meta.dirname, "../../server/dist/main.js");
  const child = spawn(process.execPath, [entry], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild = child;
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);
  child.once("exit", () => {
    if (serverChild === child) serverChild = undefined;
    if (!quitting) {
      const wait = Math.min(5000, 300 * 2 ** restartCount++);
      setTimeout(spawnServer, wait);
    }
  });
}
async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${localUrl}/api/health`);
      const health = healthSchema.safeParse(await response.json());
      if (response.ok && health.success) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Pidex server did not become ready. Recent logs:\n${logs.slice(-20).join("\n")}`);
}
async function createWindow() {
  if (!process.env.PIDEX_WEB_URL) {
    if (!serverChild) spawnServer();
    await waitForServer();
  }
  const window = new BrowserWindow({
    icon: appIconPath,
    width: 1280,
    height: 820,
    minWidth: 320,
    minHeight: 560,
    backgroundColor: "#181b18",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(localUrl)) event.preventDefault();
  });
  await window.loadURL(process.env.PIDEX_WEB_URL ?? localUrl);
}

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
  ipcMain.handle("pidex:pick-project", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, {
      title: "Open a project in Pidex",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on("before-quit", () => {
  quitting = true;
  serverChild?.kill("SIGTERM");
  serverChild = undefined;
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
