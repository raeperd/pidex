import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("pidexDesktop", {
  usesIntegratedTitleBar: process.platform === "darwin",
  pickProject: (): Promise<string | null> =>
    ipcRenderer.invoke("pidex:pick-project") as Promise<string | null>,
});
