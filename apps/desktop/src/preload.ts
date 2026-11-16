import { contextBridge, ipcRenderer } from "electron";

// サンドボックスの preload は electron 以外を require できないので、チャンネル名は ipc.ts と同じ値を直接書く。

// メニューなど、殻からの操作。画面が受け取る準備をする前に来たものは、最後の 1 つを覚えておいて、準備ができたら渡す。
let commandHandler: ((command: unknown) => void) | null = null;
let pendingCommand: unknown;
ipcRenderer.on("loc-studio:command", (_event, command: unknown) => {
  if (commandHandler) commandHandler(command);
  else pendingCommand = command;
});

contextBridge.exposeInMainWorld("locStudio", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("loc-studio:pick-folder"),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke("loc-studio:open-path", target),
  onCommand: (handler: ((command: unknown) => void) | null): void => {
    commandHandler = typeof handler === "function" ? handler : null;
    if (commandHandler && pendingCommand !== undefined) {
      const command = pendingCommand;
      pendingCommand = undefined;
      commandHandler(command);
    }
  },
  projectsChanged: (): void => ipcRenderer.send("loc-studio:projects-changed"),
  platform: process.platform,
});
