const { compareVersions } = require("./version.cjs");

const UPDATE_REPO = "Error404-RedRose/AI-Creator-Studio--TwiX---PaidApp-";
const UPDATE_BRANCH = "main";
const UPDATE_REPO_URL = `https://github.com/${UPDATE_REPO}`;
const UPDATE_PACKAGE_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/resources/app/package.json`;
const UPDATE_EXE_NAME = "Creator Studio.exe";
const CACHE_MS = 60 * 1000;

function currentMode(app) {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return "portable";
  if (process.env.TWIX_DEV === "1" || !app.isPackaged) return "dev";
  return "packaged";
}

function registerUpdateHandlers({ app, ipcMain, path, fs, spawn, mainLog }) {
  let cache = null;
  let cacheAt = 0;

  async function fetchRemoteVersion() {
    const response = await fetch(`${UPDATE_PACKAGE_URL}?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Creator-Studio-Updater",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const version = String(payload?.version || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error("The published version file is not valid.");
    }
    return version;
  }

  async function checkForUpdates(force = false) {
    const currentVersion = app.getVersion();
    const mode = currentMode(app);

    if (mode !== "packaged") {
      return {
        mode,
        currentVersion,
        updateAvailable: false,
        updateDisabled: true,
        repoUrl: UPDATE_REPO_URL,
        reason:
          mode === "dev"
            ? "Updates are disabled when running the development build."
            : "The portable build cannot update itself. Use the unpacked build.",
      };
    }

    if (!force && cache && Date.now() - cacheAt < CACHE_MS) {
      return cache;
    }

    try {
      const remoteVersion = await fetchRemoteVersion();
      const result = {
        mode,
        currentVersion,
        remoteVersion,
        updateAvailable: compareVersions(remoteVersion, currentVersion) > 0,
        repoUrl: UPDATE_REPO_URL,
        checkedAt: new Date().toISOString(),
      };
      cache = result;
      cacheAt = Date.now();
      mainLog("info", "updates", "update check complete", {
        currentVersion,
        remoteVersion,
        updateAvailable: result.updateAvailable,
      });
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      mainLog("warning", "updates", "update check failed", { message });
      return {
        mode,
        currentVersion,
        updateAvailable: false,
        repoUrl: UPDATE_REPO_URL,
        error: message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async function beginUpdate() {
    const mode = currentMode(app);
    if (mode !== "packaged") {
      return {
        ok: false,
        error:
          mode === "dev"
            ? "Updates are disabled when running the development build."
            : "The portable build cannot update itself. Use the unpacked build.",
      };
    }

    try {
      const status = await checkForUpdates(true);
      if (status.error) {
        return { ok: false, error: status.error };
      }
      if (!status.updateAvailable) {
        return { ok: false, error: "Creator Studio is already up to date." };
      }

      const exePath = app.getPath("exe");
      const installDir = path.dirname(exePath);
      if (!fs.existsSync(installDir)) {
        return { ok: false, error: "The application folder could not be found." };
      }
      if (!fs.existsSync(exePath)) {
        return { ok: false, error: "The running executable could not be found." };
      }

      const helperSource = path.join(__dirname, "update-helper.ps1");
      if (!fs.existsSync(helperSource)) {
        return { ok: false, error: "The update helper is missing from this build." };
      }

      const tempRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "creator-studio-update-"));
      const helper = path.join(tempRoot, "update-helper.ps1");
      fs.copyFileSync(helperSource, helper);

      const launcher = path.join(tempRoot, "run-update.cmd");
      const lines = [
        "@echo off",
        "title Creator Studio Update",
        `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-helper.ps1" -InstallDir "${installDir}" -ExeName "${UPDATE_EXE_NAME}" -Repo "${UPDATE_REPO}" -Branch "${UPDATE_BRANCH}" -ParentPid ${process.pid} -ExpectedVersion "${status.remoteVersion}"`,
        "exit /b %ERRORLEVEL%",
        "",
      ];
      fs.writeFileSync(launcher, lines.join("\r\n"), "utf8");

      const child = spawn("cmd.exe", ["/c", "start", "", launcher], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      if (!child.pid) {
        return { ok: false, error: "The update process could not be started." };
      }

      mainLog("info", "updates", "update started", {
        currentVersion: status.currentVersion,
        remoteVersion: status.remoteVersion,
        installDir,
        helper,
      });

      setTimeout(() => {
        try {
          app.quit();
        } catch {}
      }, 1500);

      return {
        ok: true,
        remoteVersion: status.remoteVersion,
        message: `Updating Creator Studio to ${status.remoteVersion}...`,
      };
    } catch (error) {
      const message = String(error?.message || error);
      mainLog("error", "updates", "update failed to start", { message });
      return { ok: false, error: message };
    }
  }

  ipcMain.handle("updates:check", (_event, force) => checkForUpdates(Boolean(force)));
  ipcMain.handle("updates:apply", () => beginUpdate());

  mainLog("info", "updates", "update handlers ready", {
    repo: UPDATE_REPO,
    branch: UPDATE_BRANCH,
    mode: currentMode(app),
  });
}

module.exports = { registerUpdateHandlers, compareVersions, UPDATE_REPO, UPDATE_BRANCH, UPDATE_EXE_NAME };
