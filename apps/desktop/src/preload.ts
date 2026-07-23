import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pidexDesktop", {
  pickProject: (): Promise<string | null> => ipcRenderer.invoke("pidex:pick-project") as Promise<string | null>,
});
