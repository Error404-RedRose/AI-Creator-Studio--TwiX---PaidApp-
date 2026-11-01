const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twixDesktop", {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  fill: () => ipcRenderer.send("win:fill"),
  close: () => ipcRenderer.send("win:close"),
  home: () => ipcRenderer.send("win:home"),
  openPath: (target) => ipcRenderer.invoke("shell:openPath", target),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  readClipboardText: () => ipcRenderer.invoke("clipboard:readText"),
  pasteClipboard: () => ipcRenderer.invoke("edit:paste"),
  pickDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  saveTextFile: (defaultName, content, filters) => ipcRenderer.invoke("file:saveText", { defaultName, content, filters }),
  openTextFile: (filters) => ipcRenderer.invoke("file:openText", { filters }),
  log: (entry) => ipcRenderer.send("app:log", entry),
  onHome: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("twix:home", handler);
    return () => ipcRenderer.removeListener("twix:home", handler);
  },
  onServerExit: (callback) => {
    const handler = (_event, code) => callback(code);
    ipcRenderer.on("twix:server-exit", handler);
    return () => ipcRenderer.removeListener("twix:server-exit", handler);
  },
});
