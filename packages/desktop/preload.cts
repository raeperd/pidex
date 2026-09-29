import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  newSession: (projectPath: string, sessionId: string) =>
    ipcRenderer.invoke("new-session", { projectPath, sessionId }),
  listSessions: (projectPath: string) => ipcRenderer.invoke("list-sessions", projectPath),
  resumeSession: (locator: unknown) => ipcRenderer.invoke("resume-session", locator),
  switchProject: (projectPath: string, currentProjectPath: string, currentSessionId: string) =>
    ipcRenderer.invoke("switch-project", { projectPath, currentProjectPath, currentSessionId }),
  pickProject: () => ipcRenderer.invoke("pick-project"),
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
  recentProjects: () => ipcRenderer.invoke("recent-projects"),
  openRecentProject: (projectPath: string) =>
    ipcRenderer.invoke("open-recent-project", projectPath),
});
