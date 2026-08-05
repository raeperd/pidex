import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("pidexDesktop", {
  usesIntegratedTitleBar: process.platform === "darwin",
  pickProject: async (): Promise<string | null> => {
    const value: unknown = await ipcRenderer.invoke("pidex:pick-project");
    return typeof value === "string" ? value : null;
  },
  takeAuthGrant: async (): Promise<string | null> => {
    const value: unknown = await ipcRenderer.invoke("pidex:take-auth-grant");
    return typeof value === "string" ? value : null;
  },
});
