import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  newSession: (projectPath: string, sessionId: string, draftId: string) =>
    ipcRenderer.invoke("new-session", { projectPath, sessionId, draftId }),
  listSessions: (projectPath: string) => ipcRenderer.invoke("list-sessions", projectPath),
  listModels: (sessionId: string) => ipcRenderer.invoke("list-models", sessionId),
  resumeSession: (locator: unknown) => ipcRenderer.invoke("resume-session", locator),
  restart: () => ipcRenderer.invoke("restart-backend"),
  onCrash: (onCrash: () => void) => {
    const listener = () => onCrash();
    ipcRenderer.on("backend-crashed", listener);
    return () => ipcRenderer.removeListener("backend-crashed", listener);
  },

  stop: (runId: string) => ipcRenderer.invoke("stop-run", runId),
  send: (text: string, submissionId?: string, sessionId?: string) =>
    ipcRenderer.invoke("send-prompt", text, submissionId, sessionId),
  switchProject: (projectPath: string, sessionId: string, draftId: string) =>
    ipcRenderer.invoke("switch-project", { projectPath, sessionId, draftId }),
  subscribe: (onChange: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => onChange(value);
    ipcRenderer.on("conversation", listener);
    ipcRenderer.send("subscribe-conversation");
    return () => ipcRenderer.removeListener("conversation", listener);
  },
  chooseProject: () => ipcRenderer.invoke("choose-project"),
  pickProject: () => ipcRenderer.invoke("pick-project"),
  recentProjects: () => ipcRenderer.invoke("recent-projects"),
  openProject: (projectPath: string) => ipcRenderer.invoke("open-project", projectPath),
});
