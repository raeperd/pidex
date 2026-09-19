import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  send: (text: string) => ipcRenderer.invoke("send-prompt", text),
  watch: (onChange: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => onChange(value);
    ipcRenderer.on("conversation", listener);
    return () => ipcRenderer.removeListener("conversation", listener);
  },
  chooseProject: () => ipcRenderer.invoke("choose-project"),
});
