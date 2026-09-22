import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  listSessions: (projectPath: string) => ipcRenderer.invoke("list-sessions", projectPath),
  restart: () => ipcRenderer.invoke("restart-backend"),
  onCrash: (onCrash: () => void) => {
    const listener = () => onCrash();
    ipcRenderer.on("backend-crashed", listener);
    return () => ipcRenderer.removeListener("backend-crashed", listener);
  },

  stop: (runId: string) => ipcRenderer.invoke("stop-run", runId),
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
