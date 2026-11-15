import { contextBridge, ipcRenderer } from "electron";

// サンドボックスの preload は electron 以外を require できないので、チャンネル名は ipc.ts と同じ値を直接書く。
contextBridge.exposeInMainWorld("locStudio", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("loc-studio:pick-folder"),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke("loc-studio:open-path", target),
  platform: process.platform,
});
