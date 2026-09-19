import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  chooseProject: (): Promise<void> => ipcRenderer.invoke("choose-project"),
});
