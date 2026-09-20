import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  restart: () => ipcRenderer.invoke("restart-backend"),
  onCrash: (onCrash: () => void) => {
    const listener = () => onCrash();
    ipcRenderer.on("backend-crashed", listener);
    return () => ipcRenderer.removeListener("backend-crashed", listener);
  },
  send: (text: string, submissionId?: string) =>
    ipcRenderer.invoke("send-prompt", text, submissionId),
  subscribe: (onChange: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => onChange(value);
    ipcRenderer.on("conversation", listener);
    ipcRenderer.send("subscribe-conversation");
    return () => ipcRenderer.removeListener("conversation", listener);
  },
  chooseProject: () => ipcRenderer.invoke("choose-project"),
});
