const { app, BrowserWindow, ipcMain, shell, session, dialog, screen, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { registerUpdateHandlers } = require("./updates.cjs");

const isDev = process.env.TWIX_DEV === "1";
const appRoot = path.join(__dirname, "..");
const serverScript = path.join(appRoot, "server", "index.mjs");
const distDir = path.join(appRoot, "dist");

app.setName("Creator Studio");
app.setAppUserModelId("com.twilightstudio.creatorstudio3d");

let mainWindow = null;
let quitting = false;
let serverProc = null;
let serverPort = 4317;

const logDir = () => path.join(app.getPath("userData"), "data", "logs");
function writeMainLog(entry) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(logDir(), "electron-" + day + ".jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}
function mainLog(level, source, message, data) {
  writeMainLog({ ts: new Date().toISOString(), level, source, message, data });
}
process.on("uncaughtException", (error) => {
  mainLog("error", "electron", "uncaughtException", { message: error?.message, stack: error?.stack });
  console.error(error);
});
process.on("unhandledRejection", (error) => {
  mainLog("error", "electron", "unhandledRejection", { message: error?.message, stack: error?.stack });
  console.error(error);
});
ipcMain.on("app:log", (_event, entry) => writeMainLog(entry));

registerUpdateHandlers({ app, ipcMain, path, fs, spawn, mainLog });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } catch {}
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

function dataDir() {
  // Global user preferences + references, shared by every studio version.
  return path.join(app.getPath("documents"), "3D Creator Studio");
}

function defaultProjectDir() {
  const shared = "E:\\CREATOR STUDIO";
  try {
    if (process.platform === "win32" && fs.existsSync("E:\\")) return shared;
  } catch {}
  return path.join(app.getPath("documents"), "3D Creator Studio Projects");
}

function startServer() {
  fs.mkdirSync(dataDir(), { recursive: true });
  mainLog("info", "electron", "starting backend", { serverScript, port: serverPort, dataDir: dataDir() });
  serverProc = spawn(process.execPath, [serverScript, "--serve-dist"], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(serverPort),
      TWIX_DATA_DIR: dataDir(),
      TWIX_DEFAULT_PROJECT_DIR: defaultProjectDir(),
      TWIX_DESKTOP: "1",
    },
    windowsHide: true,
  });
  serverProc.stdout?.on("data", (chunk) => { process.stdout.write(`[server] ${chunk}`); mainLog("info", "backend.stdout", String(chunk).trim()); });
  serverProc.stderr?.on("data", (chunk) => { process.stderr.write(`[server] ${chunk}`); mainLog("warning", "backend.stderr", String(chunk).trim()); });
  serverProc.on("exit", (code) => {
    mainLog("warning", "electron", "backend exited", { code });
    if (code && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("twix:server-exit", code);
    }
  });
}

async function createWindow() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    icon: path.join(appRoot, "build", "icon.ico"),
    frame: false,
    thickFrame: false,
    hasShadow: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0b0a12",
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainLog("info", "electron", "window created", { dev: isDev, target: isDev ? "http://localhost:5173" : `http://127.0.0.1:${serverPort}` });
  mainWindow.once("ready-to-show", () => {
    // Do not call maximize() on a frameless window: Windows adds an invisible
    // resize border that leaves a 1px desktop gap above the taskbar.
    mainWindow.setResizable(false);
    const fill = { x: workArea.x, y: workArea.y, width: workArea.width + 1, height: workArea.height + 1 };
    mainWindow.setBounds(fill, false);
    mainWindow.show();
    mainWindow.setBounds(fill, false);
    mainWindow.focus();
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => mainLog("error", "electron", "render-process-gone", details));
  mainWindow.webContents.on("unresponsive", () => mainLog("warning", "electron", "window unresponsive"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const target = isDev ? "http://localhost:5173" : `http://127.0.0.1:${serverPort}`;
  const ready = await waitForServer(isDev ? target : `http://127.0.0.1:${serverPort}`, isDev ? 30000 : 60000);
  if (ready) {
    await mainWindow.loadURL(target);
  } else {
    const message = isDev
      ? "The development server did not start. Run start.bat again or check the terminal for errors."
      : "The TwiX backend did not start. Check the terminal log or try build.bat again.";
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="margin:0;background:#0b0a12;color:#ece8fa;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh"><div style="max-width:560px;text-align:center"><h1 style="font-weight:600">Creator Studio</h1><p style="color:#9b95b2;line-height:1.6">${message}</p></div></body>`,
      )}`,
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function fillWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  mainWindow.setResizable(false);
  mainWindow.setBounds({ x: area.x, y: area.y, width: area.width + 1, height: area.height + 1 }, false);
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:fill", fillWindow);
ipcMain.on("win:close", () => app.quit());
ipcMain.on("win:home", () => mainWindow?.webContents.send("twix:home"));
ipcMain.handle("dialog:openDirectory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});
ipcMain.handle("shell:openPath", async (_event, target) => {
  if (typeof target !== "string" || !target) return false;
  await shell.openPath(target);
  return true;
});
ipcMain.handle("clipboard:readText", async () => clipboard.readText());

ipcMain.handle("edit:paste", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    win?.webContents.paste();
    return true;
  } catch (error) {
    try {
      const text = clipboard.readText();
      if (text) win?.webContents.insertText(text);
      return Boolean(text);
    } catch {
      mainLog("warning", "electron", "paste failed", { message: error?.message });
      return false;
    }
  }
});

ipcMain.handle("shell:openExternal", async (_event, target) => {
  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) return false;
  await shell.openExternal(target);
  return true;
});
ipcMain.handle("file:saveText", async (_event, payload = {}) => {
  if (!mainWindow) return null;
  const { defaultName = "export.json", content = "", filters } = payload || {};
  const exportDir = path.join(app.getPath("documents"), "3D Creator Studio");
  fs.mkdirSync(exportDir, { recursive: true });
  const defaultPath = path.isAbsolute(defaultName) ? defaultName : path.join(exportDir, defaultName);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, String(content ?? ""), "utf8");
  return result.filePath;
});
ipcMain.handle("file:openText", async (_event, payload = {}) => {
  if (!mainWindow) return null;
  const { filters } = payload || {};
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error("File is larger than 100 MB.");
  return { path: filePath, name: path.basename(filePath), content: fs.readFileSync(filePath, "utf8") };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  mainLog("info", "electron", "app ready", { version: app.getVersion(), electron: process.versions.electron, userData: app.getPath("userData") });
  app.on("render-process-gone", (_event, webContents, details) => mainLog("error", "electron", "render-process-gone", details));
  app.on("child-process-gone", (_event, details) => mainLog("error", "electron", "child-process-gone", details));
  app.whenReady().then(async () => {
    const allowedPermissions = new Set(["clipboard-read", "clipboard-sanitized-write", "pointerLock"]);
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));

    if (!isDev) {
      serverPort = await freePort();
      startServer();
    }
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on("before-quit", (event) => {
    mainLog("info", "electron", "before-quit");
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const proc = serverProc;
    const finish = () => {
      killTree(proc);
      serverProc = null;
      app.quit();
    };
    fetch(`http://127.0.0.1:${serverPort}/api/projects/cleanup-temp`, {
      method: "POST",
      signal: AbortSignal.timeout(2500),
    }).catch(() => {}).finally(finish);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
