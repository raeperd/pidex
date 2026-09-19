import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  chooseProject: () => ipcRenderer.invoke("choose-project"),
});
