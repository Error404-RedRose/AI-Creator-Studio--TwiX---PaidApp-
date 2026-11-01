import express from "express";
import { WebSocketServer } from "ws";
import { spawn, exec as execCommand } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLicenseService } from "./license.mjs";

process.on("uncaughtException", (error) => {
  console.error("[TwiX] uncaughtException", error?.stack || error);
  log("error", "process", "uncaughtException", { message: error?.message, stack: error?.stack });
});
process.on("unhandledRejection", (error) => {
  console.error("[TwiX] unhandledRejection", error?.stack || error);
  log("error", "process", "unhandledRejection", { message: error?.message, stack: error?.stack });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(APP_ROOT, "dist");
// The dev server (start.bat) and the packaged app must read the SAME data
// folder, otherwise references and API keys appear to vanish between builds.
// Electron's userData on Windows is %APPDATA%/<package name>; mirror that here.
const APP_NAME = (() => {
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
    return pkg.name || "3d-creator-studio-twilight";
  } catch {
    return "3d-creator-studio-twilight";
  }
})();
const USER_DATA_DIR =
  process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME)
    : path.join(os.homedir(), ".config", APP_NAME);

// User preferences, references, logs and mods live in the user's Documents
// folder so every build/version of the studio reads the same global data.
const DOCUMENTS_DIR = process.env.TWIX_DOCUMENTS_DIR || path.join(os.homedir(), "Documents");
const GLOBAL_DATA_DIR = path.join(DOCUMENTS_DIR, "3D Creator Studio");
const DATA_DIR = process.env.TWIX_DATA_DIR || GLOBAL_DATA_DIR;
const licenseService = createLicenseService({ dataDir: DATA_DIR, documentsDir: GLOBAL_DATA_DIR });

// New projects are created here unless the user changed the folder in Settings.
const PROJECTS_ROOT =
  process.env.TWIX_DEFAULT_PROJECT_DIR ||
  (process.platform === "win32" && fssync.existsSync("E:\\")
    ? "E:\\CREATOR STUDIO"
    : path.join(DOCUMENTS_DIR, "3D Creator Studio Projects"));

// The studio now runs on one long-lived global project. Everything the AI
// learns, generates or edits is stored in this single timestamped tree.
const GLOBAL_PROJECT_ROOT =
  process.env.TWIX_GLOBAL_PROJECT_DIR ||
  (process.platform === "win32" && fssync.existsSync("E:\\")
    ? "E:\\CREATOR STUDIO\\Creator Studio Projects"
    : path.join(DOCUMENTS_DIR, "Creator Studio Projects"));
const GLOBAL_PROJECT_NAME = "Global Learning";
const GLOBAL_PROJECT_ID = "prj_globallearning";
const GLOBAL_PROJECT_FOLDERS = [
  "Learning",
  "Images",
  "FBX Objects",
  "Humanoids",
  "Research",
  "Code",
  "Chats",
  "Logs",
  "Scenes",
  "Exports",
  "Thumbnails",
];

// Older builds kept their data elsewhere; these are migrated once on boot.
const LEGACY_DATA_DIRS = [
  path.join(USER_DATA_DIR, "data"),
  path.join(os.homedir(), ".twix3d"),
  process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "3D Creator Studio by Twilight Studio", "data")
    : "",
].filter(Boolean);
const PORT = Number(process.env.PORT || 4317);
const SERVE_DIST = process.argv.includes("--serve-dist");
const BRIDGE_TOKEN = randomBytes(24).toString("hex");
const MCP_SERVER = path.join(APP_ROOT, "server", "mcp-server.mjs");
const APP_VERSION = (() => {
  try {
    return JSON.parse(fssync.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_MAX_BYTES = 8 * 1024 * 1024;

// Pre-prompt snapshots let the assistant recover the app source if an edit
// breaks the server or the renderer.
const CODE_RECOVERY_DIR = path.join(DATA_DIR, "code-recovery");
const CODE_SNAPSHOT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "release",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "coverage",
  ".twix",
  "code-recovery",
]);
const CODE_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff",
  ".zip", ".7z", ".rar", ".exe", ".dll", ".node", ".glb", ".gltf", ".fbx",
  ".blend", ".obj", ".stl", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".wav",
  ".ogg", ".mp4", ".mov", ".avi", ".pdf",
]);

function redact(value, depth = 0) {
  if (depth > 5) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 30000 ? value.slice(0, 30000) + "?[truncated]" : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 300).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|passwd|token|authorization|api[-_]?key|secret/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}

function appendLog(file, entry) {
  try {
    fssync.mkdirSync(LOG_DIR, { recursive: true });
    const target = path.join(LOG_DIR, file);
    const stat = fssync.existsSync(target) ? fssync.statSync(target) : null;
    if (stat && stat.size > LOG_MAX_BYTES) {
      const rotated = target + "." + Date.now() + ".old";
      try { fssync.renameSync(target, rotated); } catch {}
    }
    fssync.appendFileSync(target, JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

function log(level, source, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    source,
    message: String(message),
    data: data === undefined ? undefined : redact(data),
  };
  appendLog("app-" + new Date().toISOString().slice(0, 10) + ".jsonl", entry);
  if (level === "error") console.error("[AI Creator Studio]", source, message, data ?? "");
}

function logEvent(source, type, payload) {
  const entry = {
    ts: new Date().toISOString(),
    level: "debug",
    source,
    event: type,
    data: redact(payload),
  };
  appendLog("events-" + new Date().toISOString().slice(0, 10) + ".jsonl", entry);
}

async function pruneLogs() {
  try {
    await ensureDir(LOG_DIR);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const name of await fs.readdir(LOG_DIR)) {
      const target = path.join(LOG_DIR, name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
    }
  } catch {}
}


const CODING_MCP = path.join(APP_ROOT, "server", "coding-mcp.mjs");

const app = express();
app.use(express.json({ limit: "80mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  const started = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api/logs")) return;
    log("info", "http", req.method + " " + req.path + " " + res.statusCode, {
      ms: Date.now() - started,
      query: req.query,
      body: req.method === "GET" || req.path.includes("/scene") || req.path.includes("/assets") || req.path.includes("/export") ? undefined : req.body,
    });
  });
  next();
});

const server = createHttpServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const clients = new Map(); // projectId -> Set<ws>
const pendingTools = new Map(); // callId -> {resolve, timer, projectId}

function broadcast(projectId, message) {
  const set = clients.get(projectId);
  if (!set) return;
  const raw = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function writeFileAtomic(file, buffer) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, file);
}

function safeName(name, fallback = "untitled") {
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .split("\n").join(" ").split("\t").join(" ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function projectMetaPath(dir) {
  return path.join(dir, "project.twix.json");
}

function projectScenePath(dir) {
  return path.join(dir, "scene.glb");
}

async function loadProjectById(id) {
  const index = await readJson(path.join(DATA_DIR, "projects.json"), { projects: [] });
  const entry = (index.projects || []).find((p) => p.id === id);
  if (!entry) throw new Error("Project not found");
  return entry;
}

async function readProjectIndex() {
  return readJson(path.join(DATA_DIR, "projects.json"), { projects: [] });
}

async function writeProjectIndex(index) {
  await writeJsonAtomic(path.join(DATA_DIR, "projects.json"), index);
}

function sanitizeProjectPath(dir) {
  return path.resolve(dir);
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function timeStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isGlobalProjectPath(dir) {
  try {
    return isInside(path.resolve(GLOBAL_PROJECT_ROOT), path.resolve(dir));
  } catch {
    return false;
  }
}

async function ensureGlobalProject() {
  const dir = GLOBAL_PROJECT_ROOT;
  const created = !fssync.existsSync(projectMetaPath(dir));
  await ensureDir(dir);
  for (const folder of GLOBAL_PROJECT_FOLDERS) await ensureDir(path.join(dir, folder));
  for (const folder of ["icons", "textures", "backgrounds", "logos", "illustrations", "ui", "characters", "patterns", "overlays", "reference"]) {
    await ensureDir(path.join(dir, "Images", folder));
  }
  await ensureDir(path.join(dir, "assets"));
  await ensureDir(path.join(dir, "references"));
  await ensureDir(path.join(dir, "exports"));
  await ensureDir(path.join(dir, ".twix", "checkpoints"));

  const settings = await getSettings();
  const now = new Date().toISOString();
  let meta = await readJson(projectMetaPath(dir), null);
  if (!meta) {
    meta = {
      id: GLOBAL_PROJECT_ID,
      name: GLOBAL_PROJECT_NAME,
      version: 1,
      units: settings.units || "m",
      metersPerUnit: 1,
      workspace: "prop",
      createdAt: now,
      updatedAt: now,
      environment: { background: "#141320", fog: 0, ground: true, ambientIntensity: 0.55 },
      materials: [],
      cameras: [],
      checkpoints: [],
      chat: { sessionId: null, messages: [] },
      importNotes: [],
      contextNotes: [],
      temporary: false,
      global: true,
      referenceLinks: [],
      referenceFolders: [],
      settings: {
        snap: true,
        gridSize: 0.25,
        showRuler: true,
        approvalMode: settings.approvalMode || "destructive",
      },
    };
  }
  meta.id = meta.id || GLOBAL_PROJECT_ID;
  meta.name = GLOBAL_PROJECT_NAME;
  meta.global = true;
  meta.temporary = false;
  meta.updatedAt = now;
  await writeJsonAtomic(projectMetaPath(dir), meta);

  const index = await readProjectIndex();
  const entry = {
    id: meta.id,
    name: meta.name,
    path: dir,
    workspace: meta.workspace || "prop",
    createdAt: meta.createdAt || now,
    updatedAt: now,
    global: true,
    thumbnail: null,
  };
  index.projects = [entry, ...(index.projects || []).filter((project) => path.resolve(project.path) !== dir && !project.global)];
  await writeProjectIndex(index);
  return { meta, path: dir, created };
}

async function writeGlobalSnapshot(dir, kind, name, content) {
  if (!isGlobalProjectPath(dir) || content === undefined || content === null) return null;
  const folder = GLOBAL_PROJECT_FOLDERS.includes(kind) ? kind : "Learning";
  const targetDir = path.join(dir, folder);
  await ensureDir(targetDir);
  const target = path.join(targetDir, `${timeStamp()}-${safeName(name, kind)}`);
  if (typeof content === "string" || Buffer.isBuffer(content)) {
    await fs.writeFile(target, content);
  } else {
    await writeJsonAtomic(target.endsWith(".json") ? target : target + ".json", content);
  }
  return target;
}

const globalSnapshotTimes = new Map();

function samePath(a, b) {
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

async function pruneCodeSnapshots(limit = 20) {
  const snapshotsDir = path.join(CODE_RECOVERY_DIR, "snapshots");
  const entries = await fs.readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names.slice(0, Math.max(0, names.length - limit))) {
    await fs.rm(path.join(snapshotsDir, name), { recursive: true, force: true }).catch(() => null);
  }
}

async function snapshotCodeWorkspace(root, label = "prompt") {
  const appRoot = path.resolve(APP_ROOT);
  if (!samePath(root, appRoot)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(CODE_RECOVERY_DIR, "snapshots", stamp + "-" + safeName(label || "prompt", "prompt"));
  const filesDir = path.join(target, "files");
  const manifest = { root: appRoot, createdAt: new Date().toISOString(), files: [] };

  const walk = async (current, rel = "") => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (CODE_SNAPSHOT_IGNORES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (CODE_BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const content = await fs.readFile(absolute, "utf8").catch(() => null);
      if (content === null || content.includes("\u0000")) continue;
      const destination = path.join(filesDir, relative);
      await ensureDir(path.dirname(destination));
      await fs.writeFile(destination, content, "utf8");
      manifest.files.push({ path: relative, bytes: stat.size });
    }
  };

  await walk(appRoot);
  await writeJsonAtomic(path.join(target, "manifest.json"), manifest);
  await writeJsonAtomic(path.join(CODE_RECOVERY_DIR, "latest.json"), {
    snapshot: target,
    root: appRoot,
    createdAt: manifest.createdAt,
    files: manifest.files.length,
  });
  await pruneCodeSnapshots(20);
  return { path: target, files: manifest.files.length };
}

function canWriteGlobalSnapshot(key, minimumMs = 60000) {
  const last = globalSnapshotTimes.get(key) || 0;
  if (Date.now() - last < minimumMs) return false;
  globalSnapshotTimes.set(key, Date.now());
  return true;
}

async function resolveProjectFile(projectId, relPath) {
  const entry = await loadProjectById(projectId);
  const root = sanitizeProjectPath(entry.path);
  const target = path.resolve(root, relPath);
  if (!isInside(root, target)) throw new Error("Path outside project");
  return target;
}

const defaultSettings = () => ({
  units: "m",
  defaultProjectDir: PROJECTS_ROOT,
  autosaveSeconds: 8,
  checkpoints: 40,
  // Appearance defaults: the studio ships with the look currently used in the
  // Appearance tab (Twilight theme, rain background, 28px blur, 1.5x speed,
  // full zoom). New installs with no settings.json start out exactly like this.
  theme: "twilight",
  backgroundFx: "rain",
  backgroundBlur: 28,
  backgroundIntensity: 92,
  backgroundSpeed: 1.5,
  backgroundZoomPct: 100,
  textScale: 1,
  reducedMotion: false,
  soundEffects: true,
  soundVolume: 0.8,
  approvalMode: "auto",
  defaultView: "perspective",
  fov: 45,
  showGrid: true,
  showAxes: true,
  defaultImportScale: 1,
  defaultImportAxis: "Y up",
  exportFormat: "fbx",
  exportDir: "exports",
  includeTextures: true,
  mods: { enabled: ["example-hello"] },
  references: { links: [], folders: [] },
  github: {
    token: "",
    tokenKind: "",
    writeToken: "",
    writeLogin: "",
    login: "",
    name: "",
    avatarUrl: "",
    defaultOwner: "",
    defaultRepo: "",
    autoResearch: true,
    researchRepos: 5,
  },
  providers: {
    openai: { apiKey: "", model: "gpt-4o-mini", imageModel: "gpt-image-1", imageLimit: 100 },
    gemini: { apiKey: "", model: "gemini-1.5-flash", imageModel: "gemini-2.5-flash-image", imageLimit: 100 },
    ollama: { apiKey: "" },
  },
  keybindings: {
    objectMesh: "Tab",
    move: "e",
    rotate: "q",
    scale: "r",
    draw: "f",
    focus: "shift+f",
  },
  opencode: {
    executable: "opencode",
    baseUrl: "",
    modelByWorkspace: {},
    model: null,
    autoConnect: true,
  },
});

const LEGACY_PROJECT_DIRS = [
  path.join(os.homedir(), "Documents", "3D Creator Studio Projects"),
  path.join(os.homedir(), "3D Creator Studio Projects"),
];

/** Copy an older install's global data into the Documents folder once. */
/** Remove classic tokens and the old optional write token. */
async function migrateGitHubToken() {
  try {
    const settings = await getSettings();
    const token = settings.github?.token || "";
    const kind = githubTokenKind(token);
    const hasLegacy = token && kind !== "fine-grained";
    const hasWrite = Boolean(settings.github?.writeToken);
    if (!hasLegacy && !hasWrite) return;
    await saveSettings({
      github: {
        ...settings.github,
        token: hasLegacy ? "" : token,
        tokenKind: hasLegacy ? "" : "fine-grained",
        login: hasLegacy ? "" : settings.github?.login || "",
        name: hasLegacy ? "" : settings.github?.name || "",
        avatarUrl: hasLegacy ? "" : settings.github?.avatarUrl || "",
        scopes: hasLegacy ? [] : settings.github?.scopes || [],
        writeToken: "",
        writeLogin: "",
      },
    });
    log("info", "github", "removed non-fine-grained GitHub credentials", { hadLegacy: hasLegacy, hadWrite: hasWrite });
  } catch {}
}

async function migrateLegacyData() {
  const target = path.join(DATA_DIR, "settings.json");
  if (fssync.existsSync(target)) return null;
  for (const legacy of LEGACY_DATA_DIRS) {
    if (!legacy || path.resolve(legacy) === path.resolve(DATA_DIR)) continue;
    if (!fssync.existsSync(path.join(legacy, "settings.json"))) continue;
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (const name of ["settings.json", "reference-index.json", "reference-index.md", "projects.json", "mods"]) {
      const from = path.join(legacy, name);
      if (!fssync.existsSync(from)) continue;
      await fs.cp(from, path.join(DATA_DIR, name), { recursive: true }).catch(() => {});
    }
    const refs = path.join(legacy, "references");
    if (fssync.existsSync(refs)) {
      await fs.cp(refs, path.join(DATA_DIR, "references"), { recursive: true }).catch(() => {});
    }
    log("info", "data", "migrated legacy data", { from: legacy, to: DATA_DIR });
    return legacy;
  }
  return null;
}

/** Point new projects at the shared project root unless the user chose their own. */
async function normalizeProjectDir() {
  const settings = await getSettings();
  const current = settings.defaultProjectDir ? path.resolve(settings.defaultProjectDir) : "";
  const legacy = LEGACY_PROJECT_DIRS.some((dir) => path.resolve(dir) === current);
  if (!current || legacy) {
    await saveSettings({ defaultProjectDir: PROJECTS_ROOT });
    return PROJECTS_ROOT;
  }
  return settings.defaultProjectDir;
}

async function getSettings() {
  const stored = await readJson(path.join(DATA_DIR, "settings.json"), {});
  return {
    ...defaultSettings(),
    ...stored,
    opencode: { ...defaultSettings().opencode, ...(stored.opencode || {}) },
    mods: { ...defaultSettings().mods, ...(stored.mods || {}) },
    references: { ...defaultSettings().references, ...(stored.references || {}) },
    github: { ...defaultSettings().github, ...(stored.github || {}) },
    providers: {
      openai: { ...defaultSettings().providers.openai, ...(stored.providers?.openai || {}) },
      gemini: { ...defaultSettings().providers.gemini, ...(stored.providers?.gemini || {}) },
    },
  };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    opencode: { ...current.opencode, ...(patch.opencode || {}) },
    mods: { ...current.mods, ...(patch.mods || {}) },
    references: { ...current.references, ...(patch.references || {}) },
    github: { ...current.github, ...(patch.github || {}) },
    providers: {
      openai: { ...current.providers.openai, ...(patch.providers?.openai || {}) },
      gemini: { ...current.providers.gemini, ...(patch.providers?.gemini || {}) },
    },
  };
  await writeJsonAtomic(path.join(DATA_DIR, "settings.json"), next);
  return next;
}

/* ------------------------------------------------------------------ */
/* GitHub integration                                                  */
/* ------------------------------------------------------------------ */

const GITHUB_API = "https://api.github.com";
const GITHUB_CACHE_TTL = 10 * 60 * 1000;
const githubCache = new Map();

// Conservative safety limits. GitHub hard-rejects files over 100 MB and large
// pushes; staying well below those limits prevents a push from wedging the
// repository.
const GITHUB_MAX_FILE_BYTES = 25 * 1024 * 1024;
const GITHUB_MAX_BATCH_BYTES = 50 * 1024 * 1024;
const GITHUB_REPO_WARN_BYTES = 1024 * 1024 * 1024;
const GITHUB_MAX_ZIP_BYTES = 200 * 1024 * 1024;

function githubRepoApi(owner, repo, suffix = "") {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function githubEncodePath(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Which kind of GitHub credential this is. Fine-grained tokens are required for
 * repository-scoped read + write access and need an explicit permission set;
 * classic tokens use scopes (repo, read:user, ...) instead.
 */
function githubTokenKind(token) {
  const value = String(token || "").trim();
  if (/^github_pat_/i.test(value)) return "fine-grained";
  if (/^ghp_/i.test(value)) return "classic";
  if (/^gh[osu]_/i.test(value)) return "oauth";
  return value ? "unknown" : "";
}

function githubMaskToken(token) {
  const value = String(token || "");
  if (!value) return "";
  if (value.length <= 14) return value.slice(0, 4) + "...";
  return value.slice(0, 11) + "..." + value.slice(-4);
}

function githubPrimaryToken(settings) {
  const token = settings.github?.token || process.env.TWIX_GITHUB_TOKEN || "";
  // Only fine-grained tokens have the repository permissions this studio needs.
  return githubTokenKind(token) === "fine-grained" ? token : "";
}

function githubFallbackToken() {
  return "";
}

async function githubRequest(pathname, options = {}) {
  const settings = options.settings || (await getSettings());
  const token = options.token !== undefined ? options.token : githubPrimaryToken(settings);
  const headers = {
    Accept: options.accept || "application/vnd.github+json",
    "User-Agent": "3D-Creator-Studio-Twilight",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(pathname.startsWith("http") ? pathname : GITHUB_API + pathname, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 20000),
    redirect: "follow",
  });
  const bodyText = await response.text();
  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    data = bodyText;
  }
  if (!response.ok) {
    const error = new Error(data?.message || `GitHub HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    error.headers = response.headers;
    throw error;
  }
  return { data, headers: response.headers, status: response.status };
}

function githubIsRateLimited(error) {
  if (!error) return false;
  if (Number(error.status) === 429) return true;
  if (Number(error.status) !== 403) return false;
  return /rate limit|secondary|abuse detection|too many requests/i.test(String(error.message || ""));
}

function githubRetryDelayMs(error, attempt) {
  const headers = error?.headers;
  const retryAfter = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(90000, retryAfter * 1000);
  const remaining = headers?.get?.("x-ratelimit-remaining");
  const reset = Number(headers?.get?.("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(1000, Math.min(90000, reset * 1000 - Date.now() + 1000));
  }
  return [4000, 10000, 25000, 45000][Math.min(attempt, 3)];
}

async function githubRequestWithRetry(pathname, options = {}) {
  const maxAttempts = 4;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await githubRequest(pathname, options);
    } catch (error) {
      lastError = error;
      const retryable =
        githubIsRateLimited(error) ||
        (Number(error.status) >= 500 && Number(error.status) <= 599) ||
        /fetch failed|network|timeout|aborted/i.test(String(error.message || ""));
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const delayMs = githubRetryDelayMs(error, attempt);
      log("warning", "github", "retrying GitHub request", {
        pathname,
        status: error.status,
        attempt: attempt + 1,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Call the GitHub API with the saved token. When a permission error comes back
 * and an optional second (push) token is configured, retry once with that token
 * so pushes to an organisation or second account keep working.
 */
async function githubApi(pathname, options = {}) {
  const settings = options.settings || (await getSettings());
  const primary = options.token !== undefined ? options.token : githubPrimaryToken(settings);
  try {
    return await githubRequestWithRetry(pathname, options);
  } catch (error) {
    const fallback = githubFallbackToken(settings);
    const retryable =
      options.fallback !== false &&
      fallback &&
      fallback !== primary &&
      (error?.status === 401 || error?.status === 403);
    if (!retryable) throw error;
    return githubRequestWithRetry(pathname, { ...options, token: fallback });
  }
}

/**
 * Turn a GitHub permission failure into something the user can act on. Push
 * failures on fine-grained tokens are almost always a missing Contents /
 * Administration permission or a token that was not scoped to the repo.
 */
function githubWriteHint(error, settings, repoLabel) {
  const status = Number(error?.status || 0);
  if (status !== 403 && status !== 404 && status !== 401) return "";
  const kind = settings.github?.tokenKind || githubTokenKind(settings.github?.token);
  const target = repoLabel ? ` ${repoLabel}` : "";
  if (kind === "fine-grained") {
    return [
      `GitHub refused the write to${target}.`,
      "The fine-grained token needs Repository access for this repo and these Repository permissions:",
      "Contents = Read and write, Metadata = Read-only, Administration = Read and write (to create repos), Issues / Pull requests = Read and write.",
      "Open Settings -> GitHub in the studio to remove the old key and paste a new one.",
    ].join(" ");
  }
  return [
    `GitHub refused the write to${target}.`,
    "Only fine-grained GitHub tokens are supported. Create one with the setup button in Settings -> GitHub.",
  ].join(" ");
}

function githubScopes(headers) {
  const raw = headers?.get?.("x-oauth-scopes") || "";
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeGitHubRepo(repo) {
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: Boolean(repo.private),
    html_url: repo.html_url,
    description: repo.description || null,
    default_branch: repo.default_branch || "main",
    updated_at: repo.updated_at,
    stargazers_count: repo.stargazers_count,
    language: repo.language || null,
    // GitHub reports disk usage in KB. Keep it so the studio can show the
    // repository size instead of "size unknown".
    size: Number.isFinite(Number(repo.size)) ? Number(repo.size) : 0,
    owner: { login: repo.owner?.login || "", avatar_url: repo.owner?.avatar_url || "" },
  };
}

async function githubAccountStatus(options = {}) {
  const settings = await getSettings();
  const storedToken = settings.github?.token || "";
  const usableToken = githubPrimaryToken(settings);
  const tokenConfigured = Boolean(usableToken);
  const extras = {
    tokenKind: githubTokenKind(storedToken),
    tokenPreview: githubMaskToken(storedToken),
    legacyTokenConfigured: Boolean(storedToken && !usableToken),
  };
  if (!tokenConfigured) {
    return {
      ok: true,
      connected: false,
      tokenConfigured: false,
      login: settings.github?.login || "",
      name: settings.github?.name || "",
      avatarUrl: settings.github?.avatarUrl || "",
      defaultOwner: settings.github?.defaultOwner || "",
      defaultRepo: settings.github?.defaultRepo || "",
      autoResearch: settings.github?.autoResearch !== false,
      ...extras,
    };
  }
  try {
    // Never let the optional push token mask a broken primary token here.
    const { data, headers } = await githubRequest("/user", { settings, fallback: false, ...options });
    return {
      ok: true,
      connected: true,
      tokenConfigured: true,
      login: data.login,
      name: data.name || data.login,
      avatarUrl: data.avatar_url,
      defaultOwner: settings.github?.defaultOwner || data.login,
      defaultRepo: settings.github?.defaultRepo || "",
      autoResearch: settings.github?.autoResearch !== false,
      scopes: githubScopes(headers),
      publicRepos: data.public_repos,
      ...extras,
    };
  } catch (error) {
    return {
      ok: false,
      connected: false,
      tokenConfigured: true,
      login: settings.github?.login || "",
      name: settings.github?.name || "",
      avatarUrl: settings.github?.avatarUrl || "",
      defaultOwner: settings.github?.defaultOwner || "",
      defaultRepo: settings.github?.defaultRepo || "",
      autoResearch: settings.github?.autoResearch !== false,
      error: error.message,
      ...extras,
    };
  }
}

function githubQueryFromPrompt(query) {
  return tokenizeReference(query)
    .filter((term) => term.length > 2)
    .slice(0, 8)
    .join(" ");
}

async function githubContextFor(query) {
  try {
    const settings = await getSettings();
    if (settings.github?.autoResearch === false) return "";
    const q = githubQueryFromPrompt(query);
    if (!q) return "";
    const cached = githubCache.get(q);
    if (cached && Date.now() - cached.at < GITHUB_CACHE_TTL) return cached.text;
    const limit = Math.max(1, Math.min(8, Number(settings.github?.researchRepos || 5)));
    const lines = [];
    const repoResult = await githubApi(
      `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`,
      { settings, timeoutMs: 6000 },
    ).catch(() => null);
    for (const item of repoResult?.data?.items || []) {
      lines.push(
        `- [repo] ${item.full_name} (${item.stargazers_count || 0} stars${item.language ? ", " + item.language : ""}) - ${item.html_url}${item.description ? " - " + String(item.description).slice(0, 180) : ""}`,
      );
    }
    if (settings.github?.token) {
      const codeResult = await githubApi(
        `/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`,
        { settings, timeoutMs: 6000, accept: "application/vnd.github.text-match+json" },
      ).catch(() => null);
      for (const item of codeResult?.data?.items || []) {
        const fragment = item.text_matches?.[0]?.fragment || "";
        lines.push(
          `- [code] ${item.repository?.full_name || ""}/${item.path} - ${item.html_url}${fragment ? "\n  " + fragment.replace(/\s+/g, " ").slice(0, 240) : ""}`,
        );
      }
    }
    const result = lines.length
      ? "GitHub research matches for this request (browse repositories, read files and reuse patterns; verify before copying):\n" + lines.join("\n")
      : "";
    githubCache.set(q, { at: Date.now(), text: result });
    if (githubCache.size > 200) {
      for (const key of githubCache.keys()) {
        if (githubCache.size <= 150) break;
        githubCache.delete(key);
      }
    }
    return result;
  } catch {
    return "";
  }
}


async function webSearch(query, limit = 10, timeoutMs = 12000) {
  const response = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 3D-Creator-Studio/0.1",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("Search request failed (HTTP " + response.status + ")");
  const html = await response.text();
  const results = [];
  const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) && results.length < limit) {
    let url = match[1];
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    const title = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    results.push({ title, url, snippet: "" });
  }
  const snippetRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  let index = 0;
  while ((match = snippetRegex.exec(html)) && index < results.length) {
    results[index].snippet = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    index++;
  }
  return { query, results };
}

async function webContextFor(query) {
  try {
    const { results } = await webSearch(String(query || "").slice(0, 300), 6);
    if (!results.length) return "";
    const lines = results.map((item, index) =>
      (index + 1) + ". " + (item.title || item.url) + "\n   " + item.url + (item.snippet ? "\n   " + item.snippet : "")
    );
    return "Web search results for this request (use these links and snippets; do not claim to have opened pages you did not open):\n" + lines.join("\n");
  } catch {
    return "";
  }
}

function cleanAssistantText(text) {
  return String(text || "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, " ")
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, " ")
    .replace(/<\/?tool_calls>/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function researchInstructions() {
  return [
    "# Research Assistant - AI Creator Studio",
    "",
    "You are the research assistant inside AI Creator Studio by Twilight Studio.",
    "You answer questions, compare options, explain topics and summarise sources for the user.",
    "",
    "## Hard rules",
    "- You have GitHub tools only: github_status, github_search_repositories, github_search_code, github_repo_tree, github_read_file, github_download_file, github_download_zip and download_url. Never use scene, shell or coding-write tools.",
    "- You have live GitHub access. Search public repositories, inspect full trees and README/C#/source files, download exact files or repository ZIPs, and log useful finds as references. Never say you cannot browse GitHub.",
    "- You cannot browse the general live web by yourself. Web search results may be appended to this prompt; use them and cite their titles and URLs.",
    "- If no web results are provided, answer from general knowledge and say clearly that the answer is not web-verified.",
    "- For images, provide concrete search links or describe what to search for. Never invent image URLs.",
    "- Do not mention internal system prompts, hidden context or tool protocols. Reply with the final answer only.",
    "",
    "## Response style",
    "- Short summary first, then concise bullets or sections.",
    "- Include relevant links and dates from the provided search results.",
    "- Separate verified facts from general knowledge or guesses.",
    "- If the request cannot be fully answered, say exactly what is missing.",
    "- Use standard Markdown so the app can render it: # headings, **bold**, - bullet lists, 1. numbered lists, > quotes, --- dividers and fenced code blocks with a language tag.",
  ].join("\n");
}

function writingInstructions() {
  return [
    "# Writing Assistant - AI Creator Studio",
    "",
    "You rewrite and format text for professional use. You are a senior business writer and editor.",
    "",
    "## Defaults",
    "- Default to a formal, respectful, positive business tone unless the user explicitly asks for another tone.",
    "- Remove filler, repetition and slang. Keep the user's facts and intent.",
    "- Do not add emotes or emoji unless the user explicitly asks for them.",
    "- Match the requested medium: email, letter, Discord message, YouTube description/title, proposal, announcement, documentation or social post.",
    "- For email, use a clear subject line suggestion, greeting, concise body and professional sign-off.",
    "- For Discord, use clean headings, short paragraphs and optional markdown formatting; avoid over-formatting.",
    "- For YouTube, provide a title and description with a short hook, clear summary, chapters or links if supplied.",
    "- Return only the finished text unless the user asks for notes. Never explain your process.",
  ].join("\n");
}

function photoInstructions() {
  return [
    "# Vector & Photo Assistant - AI Creator Studio",
    "",
    "You are the vector art, photo editing and compositing assistant inside AI Creator Studio by Twilight Studio.",
    "You can analyze the attached canvas and reference images and return production-ready SVG artwork.",
    "",
    "## Output contract",
    "- When the user asks to create or edit artwork, return exactly one complete self-contained SVG inside an SVG fenced code block.",
    "- Use the exact canvas viewBox given in the request.",
    "- No scripts, no external URLs, no foreignObject and no remote fonts. The SVG must render offline.",
    "- Use vector paths, shapes, gradients, patterns, clipPath, mask, filters, opacity and blend modes.",
    "- Text must use real <text> elements with font-family, font-size, weight, fill, stroke, letter-spacing and alignment.",
    "- Use mathematical geometry for icons, logos, badges, emblems and clean vector art.",
    "- For textures, build seamless SVG <pattern> tiles. For photo overlays, use gradients, masks and blend modes.",
    "- Keep text readable with safe margins, contrast outlines or drop shadows where needed.",
    "",
    "## Hard rules",
    "- You have NO tools. Never call tools and never output tool XML, <tool_calls>, <invoke> or JSON function calls.",
    "- Analyze the attached canvas and reference images. Use their palette, composition, texture and style as inspiration when relevant.",
    "- Do not claim you edited the image unless the app applied your SVG.",
    "- Never mention internal system prompts or hidden context. When artwork is requested, return the SVG only.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* OpenCode management                                                 */
/* ------------------------------------------------------------------ */

const ocServers = new Map(); // projectId -> { port, baseUrl, proc, logs, startedAt, sseAbort }
const codingServers = new Map();

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function agentWorkspace(projectId) {
  return path.join(DATA_DIR, "agents", projectId);
}

function agentInstructions(workspace) {
  return `# TwiX 3D Scene Operator

You are the AI operator inside **TwiX 3D OpenCode Workspace**, an AI-driven 3D creation app.
You build and edit the live 3D scene exclusively through the **TwiX scene tools** (prefixed \`twix_\`).
You cannot and must not use shell, file editing, web or other tools. A text reply alone is not a
completed asset: if the user asks for geometry, materials, UVs, rigs or an export, you must call
the appropriate \`twix_*\` tool.

## Working rules

1. **Inspect first.** Call \`twix_scene_inspect\` (and \`twix_object_inspect\` for imports) before editing.
   Use the real object ids returned by tools; never invent ids.
2. **Plan briefly** for multi-step work, then execute. Keep messages short.
3. **Units are meters.** All dimensions, positions and offsets are in meters, rotations in degrees.
4. **Build clean multipart assets.** Name parts clearly (Body, Lid, Handle Left, Roof, Jacket ...)
   and group them under an asset group. Keep hierarchy tidy.
5. **Never guess at imported assets.** Inspect them, preserve the original reference, and edit the
   editable working copy. Report what cannot be safely modified (e.g. single-mesh imports).
6. **Textures:** create a material, generate/assign maps, assign the material to the right object or
   material slot, then verify with \`twix_object_inspect\` or \`twix_uv_inspect\`.
7. **Clothing:** garments must be skinned, not merely parented. Use \`twix_garment_bind\` after
   \`twix_garment_create\`, then \`twix_weights_inspect\` and report cleanup needs.
8. **Validate before export** with \`twix_scene_validate\`; export with \`twix_export_scene\` and report
   the written path and warnings.
9. **Show your work.** Select the objects you are editing so the user sees them, and use
   \`twix_viewport_set\` to frame the result. The user can see your reasoning, so keep it concise and
   purposeful.
10. **Respect the active studio.** Current studio: **${workspace}**. Use the specialist tools that fit.
11. If a tool returns \`ok: false\`, read the error, adjust and retry once; then explain the blocker.
12. The app owns approval prompts. Do not pause in text waiting for permission; call the tool and the
    workspace will ask the user when required.

## Response style

- Short status updates between tool calls.
- Use markdown with object names, dimensions and ids where useful.
- Summarise what changed, what was created, warnings, and the next sensible step.
- Never claim something happened unless the tool result says it did.
`;
}

async function writeAgentWorkspace(projectId, workspace) {
  const dir = agentWorkspace(projectId);
  await ensureDir(dir);
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      twix: {
        type: "local",
        command: [process.execPath, MCP_SERVER],
        enabled: true,
        timeout: 300000,
        environment: {
          TWIX_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
          TWIX_BRIDGE_TOKEN: BRIDGE_TOKEN,
          TWIX_PROJECT_ID: projectId,
        },
      },
      github: {
        type: "local",
        command: [process.execPath, CODING_MCP],
        enabled: true,
        timeout: 300000,
        environment: {
          TWIX_CODING_ROOT: globalReferencesDir(),
          TWIX_CODING_TRUSTED: "1",
          TWIX_GITHUB_ONLY: "1",
          TWIX_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
          TWIX_BRIDGE_TOKEN: BRIDGE_TOKEN,
        },
      },
    },
    tools: { "*": false, "twix_*": true, "github_*": true, download_url: true, task: false },
    permission: { "*": "allow" },
    agent: {
      twix: {
        description: "TwiX 3D scene operator — builds assets through TwiX tools.",
        mode: "primary",
        prompt: "{file:./AGENTS.md}",
        tools: { "*": false, "twix_*": true, "github_*": true, download_url: true, task: false },
      },
      photo: {
        description: "Photo editor assistant for SVG artwork and image editing guidance.",
        mode: "primary",
        prompt: "{file:./PHOTO.md}",
        tools: { "*": false, "github_*": true, download_url: true },
      },
      research: {
        description: "Research assistant for chat, web summaries and reference work.",
        mode: "primary",
        prompt: "{file:./RESEARCH.md}",
        tools: { "*": false, "github_*": true, "download_url": true, task: false },
      },
      writer: {
        description: "Professional writing, rewriting and formatting assistant.",
        mode: "primary",
        prompt: "{file:./WRITING.md}",
        tools: { "*": false, "github_*": true, download_url: true },
      },
    },
  };
  await writeJsonAtomic(path.join(dir, "opencode.json"), config);
  await fs.writeFile(path.join(dir, "AGENTS.md"), agentInstructions(workspace), "utf8");
  await fs.writeFile(path.join(dir, "RESEARCH.md"), researchInstructions(), "utf8");
  await fs.writeFile(path.join(dir, "PHOTO.md"), photoInstructions(), "utf8");
  await fs.writeFile(path.join(dir, "WRITING.md"), writingInstructions(), "utf8");
  return dir;
}

async function waitForHealth(baseUrl, auth, timeoutMs = 30000) {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: basicAuth(auth) },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return body;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`OpenCode server did not become healthy: ${lastError}`);
}

async function subscribeEvents(state, projectId, channel = "opencode") {
  if (state.sseAbort) return;
  const controller = new AbortController();
  state.sseAbort = controller;
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`${state.baseUrl}/event`, {
          headers: { Accept: "text/event-stream", Authorization: basicAuth(state.auth) },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        broadcast(projectId, { type: channel === "coding" ? "coding.status" : "opencode.status", status: "connected" });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const event = JSON.parse(payload);
                state.events.push({
                  type: event?.type,
                  sessionID:
                    event?.properties?.sessionID ||
                    event?.properties?.part?.sessionID ||
                    event?.properties?.info?.sessionID ||
                    null,
                  at: Date.now(),
                });
                if (state.events.length > 120) state.events.splice(0, state.events.length - 120);
                logEvent(channel === "coding" ? "coding.opencode" : "opencode", event?.type, event);
                broadcast(projectId, { type: channel === "coding" ? "coding.event" : "opencode.event", event });
              } catch {
                /* ignore malformed event */
              }
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        broadcast(projectId, { type: channel === "coding" ? "coding.status" : "opencode.status", status: "reconnecting", error: error.message });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
  run();
}

async function startOpenCode(projectId, workspace = "prop", force = false) {
  const existing = ocServers.get(projectId);
  const existingDead = Boolean(existing && (existing.proc.exitCode !== null || existing.proc.signalCode !== null));
  if (existing && !force && !existing.stopped && !existing.proc.killed && !existingDead) {
    return existing;
  }
  if (existing) {
    existing.stopped = true;
    if (existing.restartTimer) {
      clearTimeout(existing.restartTimer);
      existing.restartTimer = null;
    }
    killProcessTree(existing.proc);
    try {
      existing.sseAbort?.abort();
    } catch {}
    ocServers.delete(projectId);
  }

  const settings = await getSettings();
  const dir = await writeAgentWorkspace(projectId, workspace);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const auth = {
    username: "twix",
    password: randomBytes(18).toString("hex"),
  };
  const proc = spawn(
    settings.opencode?.executable || "opencode",
    ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure", "--print-logs", "--log-level", "WARN"],
    {
      cwd: dir,
      env: {
        ...process.env,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_SERVER_USERNAME: auth.username,
        OPENCODE_SERVER_PASSWORD: auth.password,
        ...(settings.providers?.ollama?.apiKey ? { OLLAMA_API_KEY: settings.providers.ollama.apiKey } : {}),
      },
      shell: process.platform === "win32",
      windowsHide: true,
    },
  );
  proc.stdout?.on("data", (d) => pushLog(logs, d));
  proc.stderr?.on("data", (d) => pushLog(logs, d));
  proc.on("error", (error) => pushLog(logs, `spawn error: ${error.message}`));
  proc.on("exit", (code) => {
    pushLog(logs, `opencode exited (${code})`);
    broadcast(projectId, { type: "opencode.status", status: "disconnected" });
    try { state.sseAbort?.abort(); } catch {}
    if (state.stopped || ocServers.get(projectId) !== state) return;
    if (state.restartTimer) return;
    const attempt = (state.restartAttempts || 0) + 1;
    state.restartAttempts = attempt;
    const delay = Math.min(30000, 1200 * 2 ** Math.min(attempt - 1, 4));
    pushLog(logs, `opencode will restart in ${delay}ms (attempt ${attempt})`);
    state.restartTimer = setTimeout(async () => {
      state.restartTimer = null;
      if (state.stopped || ocServers.get(projectId) !== state) return;
      try {
        const next = await startOpenCode(projectId, workspace, true);
        if (next) next.restartAttempts = 0;
        broadcast(projectId, { type: "opencode.status", status: "connected", restarted: true });
      } catch (error) {
        pushLog(state.logs, `opencode restart failed: ${error.message}`);
        const nextState = ocServers.get(projectId);
        if (nextState && nextState !== state) {
          nextState.restartAttempts = Math.max(1, attempt);
          scheduleOpenCodeRestart(projectId, nextState, workspace, attempt);
        } else {
          scheduleOpenCodeRestart(projectId, state, workspace, attempt);
        }
      }
    }, delay);
  });

  const state = { port, baseUrl, proc, logs, auth, events: [], startedAt: Date.now(), sseAbort: null };
  ocServers.set(projectId, state);

  try {
    const health = await waitForHealth(baseUrl, auth);
    state.version = health.version;
    await subscribeEvents(state, projectId);
    return state;
  } catch (error) {
    state.startupError = error.message;
    throw error;
  }
}

function scheduleOpenCodeRestart(projectId, state, workspace, previousAttempt = 0) {
  if (!state || state.stopped || ocServers.get(projectId) !== state) return;
  if (state.restartTimer) return;
  const attempt = Math.max(1, previousAttempt + 1);
  state.restartAttempts = attempt;
  const delay = Math.min(30000, 1200 * 2 ** Math.min(attempt - 1, 4));
  pushLog(state.logs, `opencode will restart in ${delay}ms (attempt ${attempt})`);
  state.restartTimer = setTimeout(async () => {
    state.restartTimer = null;
    if (state.stopped || ocServers.get(projectId) !== state) return;
    try {
      const next = await startOpenCode(projectId, workspace, true);
      if (next) next.restartAttempts = 0;
      broadcast(projectId, { type: "opencode.status", status: "connected", restarted: true });
    } catch (error) {
      pushLog(state.logs, `opencode restart failed: ${error.message}`);
      const nextState = ocServers.get(projectId);
      scheduleOpenCodeRestart(projectId, nextState && nextState !== state ? nextState : state, workspace, attempt);
    }
  }, delay);
}

function killProcessTree(proc) {
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

function runCommandCapture(command, timeout = 10000) {
  return new Promise((resolve) => {
    execCommand(
      command,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, shell: true },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

async function listBunProcesses() {
  if (process.platform !== "win32") return [];
  const script = [
    "$bun = Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\"",
    "$out = foreach ($p in $bun) {",
    "  $parentAlive = $null -ne (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue)",
    "  [pscustomobject]@{ ProcessId = $p.ProcessId; ParentProcessId = $p.ParentProcessId; ParentAlive = $parentAlive; CommandLine = $p.CommandLine }",
    "}",
    "@($out) | ConvertTo-Json -Compress",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runCommandCapture(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
  if (!result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item && item.ProcessId);
  } catch {
    return [];
  }
}

/**
 * Keeps OpenCode's Bun workers from piling up. Orphaned workers (whose parent
 * OpenCode process is gone) are always removed. With force, workers that point
 * at this app's data folder are removed too.
 */
async function cleanupBunProcesses(force = false) {
  if (process.platform !== "win32") return { checked: 0, killed: [] };
  const processes = await listBunProcesses();
  const killed = [];
  for (const item of processes) {
    const commandLine = String(item.CommandLine || "");
    const ours =
      commandLine.toLowerCase().includes(String(DATA_DIR).toLowerCase()) ||
      /coding-agents|3d creator studio|opencode/i.test(commandLine);
    const orphan = item.ParentAlive === false;
    if (!orphan && !(force && ours)) continue;
    const result = await runCommandCapture(`taskkill /PID ${Number(item.ProcessId)} /T /F`, 8000);
    if (result.code === 0 || /success/i.test(result.stdout)) killed.push(Number(item.ProcessId));
  }
  return { checked: processes.length, killed };
}

async function stopProjectServers(projectId) {
  let stopped = false;
  try {
    const coding = codingServers.get(projectId);
    if (coding?.proc) {
      coding.stopped = true;
      if (coding.restartTimer) {
        clearTimeout(coding.restartTimer);
        coding.restartTimer = null;
      }
      stopCodingWatcher(coding);
      killProcessTree(coding.proc);
      coding.sseAbort?.abort?.();
      stopped = true;
    }
    codingServers.delete(projectId);
  } catch {}
  try {
    const opencode = ocServers.get(projectId);
    if (opencode?.proc) {
      opencode.stopped = true;
      if (opencode.restartTimer) {
        clearTimeout(opencode.restartTimer);
        opencode.restartTimer = null;
      }
      killProcessTree(opencode.proc);
      opencode.sseAbort?.abort?.();
      stopped = true;
    }
    ocServers.delete(projectId);
  } catch {}
  if (stopped) await new Promise((resolve) => setTimeout(resolve, 700));
}

function pushLog(logs, data) {
  const text = String(data);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    logs.push(line.slice(0, 500));
  }
  if (logs.length > 200) logs.splice(0, logs.length - 200);
}

function basicAuth(auth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

async function ocFetch(state, pathname, options = {}) {
  const res = await fetch(`${state.baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuth(state.auth),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenCode ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res.text();
}

const providerCredentialCache = new Map();

function availableModelIds(payload) {
  const list = payload?.data || payload?.models || payload?.model || [];
  const ids = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string") ids.push(item);
      else if (item?.id || item?.name || item?.model) ids.push(String(item.id || item.name || item.model));
    }
  } else if (list && typeof list === "object") {
    for (const [id, item] of Object.entries(list)) ids.push(String(item?.id || item?.name || id));
  }
  return [...new Set(ids.filter(Boolean))];
}

async function providerAvailableModels(provider, models) {
  const key = provider?.key ? String(provider.key) : "";
  if (!key) return null;
  const apiUrl = models.find((model) => model?.api?.url)?.api?.url || "";
  if (!apiUrl) return null;
  let base = String(apiUrl).replace(/\/chat\/completions\/?$/i, "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  const cacheKey = provider.id + "|" + base + "|" + key.slice(-12);
  const cached = providerCredentialCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 120000) return cached.ids;
  try {
    const response = await fetch(base + "/models", {
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
        "User-Agent": "AI-Creator-Studio/0.6",
      },
      signal: AbortSignal.timeout(4000),
    });
    // Never hide a keyed provider because a /models endpoint rejects or is
    // unavailable. Use the list only to narrow the catalog when it is valid.
    const ids = response.ok ? availableModelIds(await response.json().catch(() => null)) : null;
    const result = ids && ids.length ? ids : null;
    providerCredentialCache.set(cacheKey, { at: Date.now(), ids: result });
    if (providerCredentialCache.size > 40) {
      for (const cache of providerCredentialCache.keys()) {
        if (providerCredentialCache.size <= 30) break;
        providerCredentialCache.delete(cache);
      }
    }
    return result;
  } catch {
    return null;
  }
}

async function normalizeProviders(payload) {
  const providers = payload?.providers || payload?.all || [];
  const connectedList = Array.isArray(payload?.connected) ? payload.connected : null;
  return Promise.all(
    providers.map(async (provider) => {
      const envKeys = Array.isArray(provider.env) ? provider.env : [];
      const modelEntries = Array.isArray(provider.models)
        ? provider.models.map((model) => [model?.id || model?.modelID || "", model])
        : Object.entries(provider.models || {});
      const hasKey = Boolean(provider.key);
      const connected = connectedList
        ? connectedList.includes(provider.id)
        : !envKeys.length || hasKey;
      const availableIds = hasKey
        ? await providerAvailableModels(provider, modelEntries.map(([, model]) => model))
        : null;
      let catalog = modelEntries.filter(([id]) => Boolean(id));
      if (availableIds?.length) {
        const normalized = new Set(availableIds.map((id) => String(id).toLowerCase().replace(/:latest$/, "")));
        const filteredModels = catalog.filter(([id]) => normalized.has(String(id).toLowerCase().replace(/:latest$/, "")));
        if (filteredModels.length) catalog = filteredModels;
      }
      return {
        id: provider.id,
        name: provider.name || provider.id,
        connected,
        models: catalog.map(([id, model]) => ({
          id,
          name: model?.name || id,
          tools: model?.tools !== false,
          reasoning: Boolean(model?.reasoning || model?.capabilities?.reasoning),
          context: model?.limit?.context || null,
          status: model?.status || "active",
        })),
      };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Coding workspace OpenCode server                                    */
/* ------------------------------------------------------------------ */

function codingInstructions(dir, trusted, unityPort = null) {
  const unitySection = unityPort
    ? `

## Linked Unity Editor
A live Unity Editor bridge is connected on port ${unityPort}. The Unity and Coding applets share this workspace and conversation.
Use the \`unity_*\` tools for every Unity scene, asset, component, material or editor action:
\`unity_state\`, \`unity_get_object\`, \`unity_find_objects\`, \`unity_find_assets\`, \`unity_compile\`, \`unity_refresh\`, \`unity_focus\`, \`unity_create_object\`, \`unity_create_empty\`, \`unity_delete_object\`, \`unity_duplicate_object\`, \`unity_move_object\`, \`unity_rotate_object\`, \`unity_scale_object\`, \`unity_set_transform\`, \`unity_rename_object\`, \`unity_set_parent\`, \`unity_set_active\`, \`unity_set_tag_layer\`, \`unity_add_component\`, \`unity_remove_component\`, \`unity_set_component_enabled\`, \`unity_set_property\`, \`unity_set_material_property\`, \`unity_apply_material\`, \`unity_create_material\`, \`unity_set_setting\`, \`unity_save_scene\`, \`unity_open_scene\`, \`unity_play\` and \`unity_stop\`.
Do not use shell commands to drive or launch Unity. Shell commands are disabled in this linked workspace. After editing scripts, call \`unity_clear_compile_messages\`, then \`unity_compile\`, then \`unity_state\` and read compileMessages. The bridge records undo, marks the scene dirty and frames changed GameObjects automatically.
`
    : "";
  return `# AI Creator Studio Coding Agent

You are the coding agent inside **AI Creator Studio by Twilight Studio**.
You work through the **coding tools** (\`coding_*\`). The selected workspace is:

\`\`\`
${dir}
\`\`\`

Trusted workspace: **${trusted ? "ON ? full PC access" : "OFF ? workspace read-only"}**.

## Rules
1. Inspect the project before editing: \`coding_get_root\`, \`coding_list_files\`, \`coding_read_file\`, \`coding_search_files\`.
2. Make focused changes with \`coding_write_file\`. ${trusted ? "Trusted mode is on, so absolute paths and files outside the workspace are allowed when the user asks for them. Prefer the workspace for normal edits." : "Never write outside the workspace."}
3. Use \`coding_run_command\` for builds, tests and shell work only when trusted workspace is on. ${trusted ? "Commands run with full user access and may reference any path on this PC." : ""}
4. Explain file changes and command results clearly. Show errors and warnings in the response.
5. Do not claim a build or test passed unless the command output confirms it.
6. Keep the user's existing project structure and conventions. Do not overwrite unrelated files.
7. GitHub is live and fully available: use github_status, github_search_repositories, github_search_code, github_repo_tree, github_read_file, github_download_file and github_download_zip. Never say you cannot browse GitHub. Search public repositories, inspect full trees, read README/C#/source files, download exact files into the workspace, and log useful finds as references. Never push or post without the user asking.
8. If the workspace is read-only, say what you would change and ask the user to enable trusted workspace.
9. Work linearly: plan a short sequence, then complete one edit or command at a time. Do not spawn subagents or parallel tasks.
10. Use GitHub proactively when related repositories, code, README files or assets would improve the result. Reference and session context are supporting background; ignore them only when irrelevant.
11. Recovery: a snapshot of the app source is saved before each prompt. If your edits stop the app or server from starting, run \`node scripts/recover-last.mjs\` to restore the latest snapshot, then reapply the intended change more carefully.
12. Full refresh: after changing core app or server files, run \`node scripts/full-refresh.mjs\`. It reloads the window, restarts the supervised backend, and returns to the live Coding editor.
${unitySection}`;
}

async function writeCodingWorkspace(projectId, dir, trusted, unityPort = null) {
  const workspace = path.join(DATA_DIR, "coding-agents", projectId);
  await ensureDir(workspace);
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      coding: {
        type: "local",
        command: [process.execPath, CODING_MCP],
        enabled: true,
        timeout: 300000,
        environment: {
          TWIX_CODING_ROOT: dir,
          TWIX_CODING_TRUSTED: trusted ? "1" : "0",
          TWIX_UNITY_BRIDGE_PORT: unityPort ? String(unityPort) : "",
          TWIX_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
          TWIX_BRIDGE_TOKEN: BRIDGE_TOKEN,
          TWIX_DATA_DIR: DATA_DIR,
        },
      },
    },
    tools: { "*": false, "coding_*": true, task: false },
    permission: { "*": "allow" },
    agent: {
      coder: {
        description: "Coding workspace agent scoped to the selected project directory.",
        mode: "primary",
        prompt: "{file:./AGENTS.md}",
        tools: { "*": false, "coding_*": true, task: false },
      },
    },
  };
  await writeJsonAtomic(path.join(workspace, "opencode.json"), config);
  await fs.writeFile(path.join(workspace, "AGENTS.md"), codingInstructions(dir, trusted, unityPort), "utf8");
  return workspace;
}

function stopCodingWatcher(state) {
  if (!state) return;
  if (state.watchTimer) {
    clearTimeout(state.watchTimer);
    state.watchTimer = null;
  }
  try {
    state.watcher?.close();
  } catch {}
  state.watcher = null;
}

function startCodingWatcher(projectId, state) {
  if (!state || state.watcher) return;
  const ignored = /(^|[\\/])(node_modules|\.git|dist|release|build|\.twix)([\\/]|$)/i;
  const notify = () => {
    if (state.watchTimer) clearTimeout(state.watchTimer);
    state.watchTimer = setTimeout(() => {
      state.watchTimer = null;
      broadcast(projectId, { type: "coding.files.changed", root: state.root });
    }, 250);
  };
  try {
    state.watcher = fssync.watch(state.root, { recursive: true }, (_eventType, filename) => {
      if (filename && ignored.test(String(filename))) return;
      notify();
    });
    state.watcher.on("error", () => stopCodingWatcher(state));
  } catch {
    state.watcher = null;
  }
}

async function startCodingServer(projectId, dir, trusted, force = false, unityPort = null) {
  const existing = codingServers.get(projectId);
  const existingDead = Boolean(existing && (existing.proc.exitCode !== null || existing.proc.signalCode !== null));
  if (existing && !force && !existing.stopped && !existing.proc.killed && !existingDead && existing.root === dir && existing.trusted === trusted && existing.unityPort === unityPort) {
    return existing;
  }
  if (existing) {
    existing.stopped = true;
    if (existing.restartTimer) {
      clearTimeout(existing.restartTimer);
      existing.restartTimer = null;
    }
    stopCodingWatcher(existing);
    killProcessTree(existing.proc);
    try {
      existing.sseAbort?.abort();
    } catch {}
    codingServers.delete(projectId);
  }
  const settings = await getSettings();
  const workspace = await writeCodingWorkspace(projectId, dir, trusted, unityPort);
  await cleanupBunProcesses(false).catch(() => null);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const auth = { username: "twix", password: randomBytes(18).toString("hex") };
  const proc = spawn(settings.opencode?.executable || "opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure", "--print-logs", "--log-level", "WARN"], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
    },
    shell: process.platform === "win32",
    windowsHide: true,
  });
  proc.stdout?.on("data", (d) => pushLog(logs, d));
  proc.stderr?.on("data", (d) => pushLog(logs, d));
  proc.on("error", (error) => pushLog(logs, `spawn error: ${error.message}`));
  proc.on("exit", (code) => {
    pushLog(logs, `coding opencode exited (${code})`);
    broadcast(projectId, { type: "coding.status", status: "disconnected", error: "Coding agent exited; restarting..." });
    stopCodingWatcher(state);
    try { state.sseAbort?.abort(); } catch {}
    if (state.stopped || codingServers.get(projectId) !== state) return;
    scheduleCodingRestart(projectId, state);
  });
  const state = { port, baseUrl, proc, logs, auth, events: [], root: dir, trusted, unityPort, startedAt: Date.now(), sseAbort: null };
  codingServers.set(projectId, state);
  startCodingWatcher(projectId, state);
  const health = await waitForHealth(baseUrl, auth);
  state.version = health.version;
  await subscribeEvents(state, projectId, "coding");
  return state;
}

function scheduleCodingRestart(projectId, state, previousAttempt = 0) {
  if (!state || state.stopped || codingServers.get(projectId) !== state) return;
  if (state.restartTimer) return;
  const attempt = Math.max(1, previousAttempt + 1);
  state.restartAttempts = attempt;
  const delay = Math.min(30000, 1200 * 2 ** Math.min(attempt - 1, 4));
  pushLog(state.logs, `coding opencode will restart in ${delay}ms (attempt ${attempt})`);
  state.restartTimer = setTimeout(async () => {
    state.restartTimer = null;
    if (state.stopped || codingServers.get(projectId) !== state) return;
    try {
      const next = await startCodingServer(projectId, state.root, state.trusted, true, state.unityPort);
      if (next) next.restartAttempts = 0;
      broadcast(projectId, { type: "coding.status", status: "connected", restarted: true });
    } catch (error) {
      pushLog(state.logs, `coding opencode restart failed: ${error.message}`);
      const nextState = codingServers.get(projectId);
      scheduleCodingRestart(projectId, nextState && nextState !== state ? nextState : state, attempt);
    }
  }, delay);
}

/* ------------------------------------------------------------------ */
/* API: mods                                                           */
/* ------------------------------------------------------------------ */

function modsDirectory() {
  return path.join(DATA_DIR, "mods");
}

async function ensureExampleMod() {
  const dir = modsDirectory();
  await ensureDir(dir);
  const example = path.join(dir, "example-hello");
  if (fssync.existsSync(example)) return;
  await ensureDir(example);
  await writeJsonAtomic(path.join(example, "mod.json"), {
    id: "example-hello",
    name: "Example: Add Cube",
    version: "1.0.0",
    description: "A tiny example mod that registers a button in the Add-ons panel.",
    main: "index.js",
    author: "Twilight Studio",
  });
  await fs.writeFile(
    path.join(example, "index.js"),
    `twixMod.registerButton({
  id: "example-add-cube",
  label: "Mod: Add Cube",
  icon: "cube",
  run() {
    twixMod.runTool("object_create", {
      name: "Mod Cube",
      primitive: "box",
      dimensions: { x: 0.5, y: 0.5, z: 0.5 },
      position: { x: 0, y: 0.25, z: 0 },
      color: "#c084fc",
    });
  },
});
`,
    "utf8",
  );
}

async function listMods() {
  const settings = await getSettings();
  const enabled = new Set(settings.mods?.enabled || []);
  const dir = modsDirectory();
  await ensureDir(dir);
  const mods = [];
  for (const name of await fs.readdir(dir)) {
    const folder = path.join(dir, name);
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const manifest = await readJson(path.join(folder, "mod.json"), null);
    if (!manifest) continue;
    mods.push({
      id: manifest.id || name,
      folder: name,
      name: manifest.name || name,
      version: manifest.version || "1.0.0",
      description: manifest.description || "",
      author: manifest.author || "",
      main: manifest.main || "index.js",
      enabled: enabled.has(manifest.id || name),
    });
  }
  mods.sort((a, b) => a.name.localeCompare(b.name));
  return { mods, dir };
}


/* ------------------------------------------------------------------ */
/* Product licensing                                                    */
/* ------------------------------------------------------------------ */

app.get("/api/license/status", async (req, res) => {
  try {
    res.json(await licenseService.status());
  } catch (error) {
    res.status(500).json({
      licensed: false,
      status: "error",
      reason: error?.message || "License check failed.",
      checkedAt: new Date().toISOString(),
    });
  }
});

app.post("/api/license/refresh", async (req, res) => {
  try {
    res.json(await licenseService.status());
  } catch (error) {
    res.status(500).json({
      licensed: false,
      status: "error",
      reason: error?.message || "License check failed.",
      checkedAt: new Date().toISOString(),
    });
  }
});

app.post("/api/license/activate", async (req, res) => {
  try {
    const result = await licenseService.activate(req.body?.key);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Activation failed.",
    });
  }
});

app.get("/api/mods", async (req, res) => {
  try {
    res.json(await listMods());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/mods/:id/source", async (req, res) => {
  try {
    const { mods, dir } = await listMods();
    const mod = mods.find((item) => item.id === req.params.id);
    if (!mod) return res.status(404).json({ error: "Mod not found" });
    const folder = path.join(dir, mod.folder);
    const target = path.resolve(folder, mod.main);
    if (!isInside(folder, target)) return res.status(400).json({ error: "Invalid mod entry" });
    const source = await fs.readFile(target, "utf8");
    res.type("text/javascript").send(source);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/mods/:id/toggle", async (req, res) => {
  try {
    const { mods } = await listMods();
    const mod = mods.find((item) => item.id === req.params.id);
    if (!mod) return res.status(404).json({ error: "Mod not found" });
    const settings = await getSettings();
    const enabled = new Set(settings.mods?.enabled || []);
    if (req.body?.enabled === false) enabled.delete(mod.id);
    else enabled.add(mod.id);
    await saveSettings({ mods: { enabled: [...enabled] } });
    res.json({ ok: true, enabled: enabled.has(mod.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: settings                                                       */
/* ------------------------------------------------------------------ */

app.get("/api/settings", async (req, res) => {
  res.json(await getSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    res.json(await saveSettings(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/app/full-refresh", async (req, res) => {
  const supervised = process.env.TWIX_DEV_SUPERVISOR === "1";
  const workspace = String(req.body?.workspace || "coding");
  const delayMs = supervised ? 4000 : 500;
  for (const client of wss.clients) {
    try {
      client.send(JSON.stringify({ type: "app.full-refresh", workspace, delayMs }));
    } catch {}
  }
  res.json({ ok: true, restarting: supervised, delayMs });
  if (supervised) {
    setTimeout(async () => {
      const ids = new Set([...codingServers.keys(), ...ocServers.keys()]);
      for (const id of ids) {
        await stopProjectServers(id).catch(() => null);
      }
      process.exit(0);
    }, 900);
  }
});

app.get("/api/system/clipboard", (req, res) => {
  if (process.platform !== "win32") {
    return res.status(501).json({ error: "Clipboard bridge is only implemented on Windows." });
  }
  execCommand('powershell -NoProfile -Command "Get-Clipboard -Raw"', { windowsHide: true, timeout: 5000 }, (error, stdout) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ text: String(stdout || "").slice(0, 1024 * 1024) });
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "3d-creator-studio",
    version: APP_VERSION,
    dataDir: DATA_DIR,
    opencode: fssync.existsSync(path.join(os.homedir(), "AppData", "Roaming", "npm", "opencode.cmd")) || true,
    mcp: fssync.existsSync(MCP_SERVER),
  });
});

/* ------------------------------------------------------------------ */
/* API: projects                                                       */
/* ------------------------------------------------------------------ */

async function createProject(body) {
  const settings = await getSettings();
  const name = safeName(body.name, "Untitled Asset");
  const base = body.dir ? path.resolve(body.dir) : path.resolve(settings.defaultProjectDir);
  let dir = path.join(base, name);
  let n = 2;
  while (fssync.existsSync(dir)) {
    dir = path.join(base, `${name} ${n++}`);
  }
  await ensureDir(dir);
  await ensureDir(path.join(dir, "assets"));
  await ensureDir(path.join(dir, "references"));
  await ensureDir(path.join(dir, "exports"));
  await ensureDir(path.join(dir, ".twix", "checkpoints"));

  const now = new Date().toISOString();
  const meta = {
    id: `prj_${randomUUID().slice(0, 8)}`,
    name,
    version: 1,
    units: settings.units || "m",
    metersPerUnit: 1,
    workspace: body.workspace || "prop",
    createdAt: now,
    updatedAt: now,
    environment: {
      background: "#141320",
      fog: 0,
      ground: true,
      ambientIntensity: 0.55,
    },
    materials: [],
    cameras: [],
    checkpoints: [],
    chat: { sessionId: null, messages: [] },
    importNotes: [],
    contextNotes: [],
    temporary: Boolean(body.temporary),
    referenceLinks: [],
    referenceFolders: [],
    settings: {
      snap: true,
      gridSize: 0.25,
      showRuler: true,
      approvalMode: settings.approvalMode || "destructive",
    },
  };
  await writeJsonAtomic(projectMetaPath(dir), meta);
  const index = await readProjectIndex();
  const entry = {
    id: meta.id,
    name,
    path: dir,
    workspace: meta.workspace,
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
  };
  index.projects = [entry, ...(index.projects || []).filter((p) => p.path !== dir)];
  await writeProjectIndex(index);
  return { meta, path: dir };
}

app.get("/api/projects", async (req, res) => {
  const index = await readProjectIndex();
  const projects = [];
  for (const entry of index.projects || []) {
    if (fssync.existsSync(projectMetaPath(entry.path))) {
      const meta = await readJson(projectMetaPath(entry.path), null);
      projects.push({ ...entry, name: meta?.name || entry.name, workspace: meta?.workspace || entry.workspace, temporary: Boolean(meta?.temporary) });
    }
  }
  res.json({ projects, defaultDir: (await getSettings()).defaultProjectDir });
});

app.get("/api/global-project", async (req, res) => {
  try {
    res.json({ ok: true, ...(await ensureGlobalProject()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function saveGlobalLearning(kind = "Learning", name = "entry", data) {
  const folder = GLOBAL_PROJECT_FOLDERS.includes(kind) ? kind : "Learning";
  const dir = path.join(GLOBAL_PROJECT_ROOT, folder);
  await ensureDir(dir);
  const target = path.join(dir, `${timeStamp()}-${safeName(name, "entry")}.json`);
  await writeJsonAtomic(target, data === undefined ? {} : data);
  return target;
}

app.get("/api/global-project/context", async (req, res) => {
  try {
    const query = String(req.query.q || "");
    const [globalLearning, references] = await Promise.all([
      globalLearningContextFor(query),
      referenceContextFor(query),
    ]);
    const github = req.query.github === "1" ? await githubContextFor(query) : "";
    res.json({ ok: true, query, globalLearning, references, github });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/global-project/log", async (req, res) => {
  try {
    const { kind = "Learning", name = "entry", data } = req.body || {};
    const target = await saveGlobalLearning(kind, name, data);
    res.json({ ok: true, path: target });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const result = await createProject(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    await stopProjectServers(req.params.id);
    const dir = path.resolve(entry.path);
    fssync.rmSync(dir, { recursive: true, force: true });
    fssync.rmSync(path.join(DATA_DIR, "agents", req.params.id), { recursive: true, force: true });
    fssync.rmSync(path.join(DATA_DIR, "coding-agents", req.params.id), { recursive: true, force: true });
    const index = await readProjectIndex();
    index.projects = (index.projects || []).filter((project) => project.id !== req.params.id);
    await writeProjectIndex(index);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function codingSessionTitle(text) {
  const cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\w\s'+#.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((word) => word.length > 1).slice(0, 7);
  return words.join(" ").slice(0, 64).trim();
}

function projectNameFromContext(meta) {
  const notes = Array.isArray(meta.contextNotes) ? meta.contextNotes : [];
  const messages = meta.chat?.messages || [];
  const userMessages = messages.filter((message) => message.role === "user" && message.text).map((message) => message.text);
  const sources = [...notes, ...userMessages.reverse(), ...(meta.importNotes || [])].filter(Boolean);
  for (const source of sources) {
    const cleaned = String(source)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-zA-Z0-9\s'+#.-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = cleaned.split(" ").filter((word) => word.length > 1).slice(0, 6);
    if (words.length) {
      return words.join(" ").replace(/\b\w/g, (char) => char.toUpperCase()).slice(0, 64);
    }
  }
  const labels = { coding: "Coding Session", photo: "Photo Session", unity: "Unity Session", chat: "Research Session" };
  const label = labels[meta.workspace] || "Project";
  return label + " " + new Date(meta.createdAt || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

app.post("/api/projects/:id/smart-name", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const meta = await readJson(projectMetaPath(entry.path), null);
    if (!meta) return res.status(404).json({ error: "Project metadata not found" });
    if (isGlobalProjectPath(entry.path)) {
      meta.id = GLOBAL_PROJECT_ID;
      meta.name = GLOBAL_PROJECT_NAME;
      meta.global = true;
      meta.temporary = false;
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
      return res.json({ ok: true, meta, locked: true });
    }
    let candidate = String(req.body?.name || "").trim();
    const auto = /^(untitled|new project|untitled asset|asset|untitled session|untitled coding session|photo session)$/i.test(String(meta.name || "").trim());
    if (!candidate && (auto || meta.temporary || req.body?.force)) {
      candidate = projectNameFromContext(meta);
    }
    if (candidate && (auto || meta.temporary || req.body?.force || req.body?.name)) {
      meta.name = safeName(candidate, projectNameFromContext(meta));
      meta.temporary = false;
      meta.updatedAt = new Date().toISOString();
    await writeJsonAtomic(projectMetaPath(entry.path), meta);
    if (isGlobalProjectPath(entry.path)) {
      if (canWriteGlobalSnapshot(entry.path + ":meta", 60000)) {
        await writeGlobalSnapshot(entry.path, "Learning", `${meta.name || "session"}-meta.json`, meta).catch(() => null);
      }
      if (canWriteGlobalSnapshot(entry.path + ":chat", 60000)) {
        await writeGlobalSnapshot(
          entry.path,
          "Chats",
          `${meta.name || "session"}-chat.json`,
          { sessionId: meta.chat?.sessionId || null, messages: meta.chat?.messages || [], updatedAt: meta.updatedAt },
        ).catch(() => null);
      }
    }
    const index = await readProjectIndex();
      const target = (index.projects || []).find((project) => project.id === entry.id);
      if (target) {
        target.name = meta.name;
        target.temporary = false;
        target.updatedAt = meta.updatedAt;
        await writeProjectIndex(index);
      }
    }
    res.json({ ok: true, meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/:id/keep", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const meta = await readJson(projectMetaPath(entry.path), null);
    if (!meta) return res.status(404).json({ error: "Project metadata not found" });
    meta.temporary = false;
    meta.updatedAt = new Date().toISOString();
    await writeJsonAtomic(projectMetaPath(entry.path), meta);
    const index = await readProjectIndex();
    const target = (index.projects || []).find((project) => project.id === entry.id);
    if (target) {
      target.temporary = false;
      target.updatedAt = meta.updatedAt;
      await writeProjectIndex(index);
    }
    res.json({ ok: true, meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/cleanup-temp", async (req, res) => {
  try {
    const index = await readProjectIndex();
    const keep = [];
    const deleted = [];
    for (const entry of index.projects || []) {
      const meta = await readJson(projectMetaPath(entry.path), null);
      if (meta?.temporary) {
        deleted.push(entry.id);
        await stopProjectServers(entry.id);
        await fs.rm(entry.path, { recursive: true, force: true }).catch(() => {});
      } else {
        keep.push(entry);
      }
    }
    if (deleted.length) {
      index.projects = keep;
      await writeProjectIndex(index);
    }
    res.json({ ok: true, deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/open", async (req, res) => {
  try {
    const dir = path.resolve(req.body.path);
    const meta = await readJson(projectMetaPath(dir), null);
    if (!meta) return res.status(404).json({ error: "No project.twix.json found in that folder" });
    const index = await readProjectIndex();
    const entry = { id: meta.id, name: meta.name, path: dir, workspace: meta.workspace, updatedAt: meta.updatedAt };
    index.projects = [entry, ...(index.projects || []).filter((p) => p.path !== dir)];
    await writeProjectIndex(index);
    res.json({ meta, path: dir });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/project/:id/meta", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const meta = await readJson(projectMetaPath(entry.path), null);
    if (!meta) return res.status(404).json({ error: "Project meta missing" });
    res.json({ meta, path: entry.path, hasScene: fssync.existsSync(projectScenePath(entry.path)) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.put("/api/project/:id/meta", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const meta = req.body;
    if (isGlobalProjectPath(entry.path)) {
      meta.id = GLOBAL_PROJECT_ID;
      meta.name = GLOBAL_PROJECT_NAME;
      meta.global = true;
      meta.temporary = false;
    }
    meta.updatedAt = new Date().toISOString();
    await writeJsonAtomic(projectMetaPath(entry.path), meta);
    const index = await readProjectIndex();
    const item = (index.projects || []).find((p) => p.id === entry.id);
    if (item) {
      item.name = meta.name;
      item.workspace = meta.workspace;
      item.updatedAt = meta.updatedAt;
    }
    await writeProjectIndex(index);
    res.json({ ok: true, updatedAt: meta.updatedAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put(
  "/api/project/:id/scene",
  express.raw({ type: "application/octet-stream", limit: "300mb" }),
  async (req, res) => {
    try {
      const entry = await loadProjectById(req.params.id);
      await writeFileAtomic(projectScenePath(entry.path), req.body);
      if (isGlobalProjectPath(entry.path)) {
        if (canWriteGlobalSnapshot(entry.path + ":scene", 60000)) {
          await writeGlobalSnapshot(entry.path, "Scenes", "scene.glb", req.body).catch(() => null);
        }
      }
      res.json({ ok: true, bytes: req.body.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

app.get("/api/project/:id/scene", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const file = projectScenePath(entry.path);
    if (!fssync.existsSync(file)) return res.status(404).json({ error: "No scene yet" });
    res.type("model/gltf-binary").sendFile(file);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/project/:id/checkpoints", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const dir = path.join(entry.path, ".twix", "checkpoints");
    await ensureDir(dir);
    const names = await fs.readdir(dir);
    const list = [];
    for (const name of names) {
      const meta = await readJson(path.join(dir, name, "checkpoint.json"), null);
      if (meta) list.push(meta);
    }
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ checkpoints: list });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/project/:id/checkpoints", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const root = path.join(entry.path, ".twix", "checkpoints");
    const id = `cp_${Date.now()}_${randomUUID().slice(0, 4)}`;
    const dir = path.join(root, id);
    await ensureDir(dir);
    const metaFile = projectMetaPath(entry.path);
    const sceneFile = projectScenePath(entry.path);
    if (fssync.existsSync(metaFile)) await fs.copyFile(metaFile, path.join(dir, "project.twix.json"));
    if (fssync.existsSync(sceneFile)) await fs.copyFile(sceneFile, path.join(dir, "scene.glb"));
    const meta = await readJson(metaFile, {});
    const checkpoint = {
      id,
      label: req.body?.label || "Checkpoint",
      kind: req.body?.kind || "manual",
      createdAt: new Date().toISOString(),
      objectCount: req.body?.objectCount || null,
    };
    await writeJsonAtomic(path.join(dir, "checkpoint.json"), checkpoint);

    const settings = await getSettings();
    const names = (await fs.readdir(root)).filter((n) => n.startsWith("cp_"));
    if (names.length > (settings.checkpoints || 40)) {
      const metas = [];
      for (const n of names) {
        const m = await readJson(path.join(root, n, "checkpoint.json"), null);
        if (m) metas.push(m);
      }
      metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const excess = metas.slice(0, Math.max(0, metas.length - (settings.checkpoints || 40)));
      for (const m of excess) await fs.rm(path.join(root, m.id), { recursive: true, force: true });
    }
    res.json({ checkpoint });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/project/:id/checkpoints/:cp/restore", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const dir = path.join(entry.path, ".twix", "checkpoints", req.params.cp);
    if (!fssync.existsSync(dir)) return res.status(404).json({ error: "Checkpoint not found" });
    await fs.copyFile(path.join(dir, "project.twix.json"), projectMetaPath(entry.path));
    if (fssync.existsSync(path.join(dir, "scene.glb"))) {
      await fs.copyFile(path.join(dir, "scene.glb"), projectScenePath(entry.path));
    }
    const meta = await readJson(projectMetaPath(entry.path), {});
    res.json({ ok: true, meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: assets / files / export                                        */
/* ------------------------------------------------------------------ */

app.post(
  "/api/project/:id/assets",
  express.raw({ type: "*/*", limit: "300mb" }),
  async (req, res) => {
    try {
      const entry = await loadProjectById(req.params.id);
      const kind = req.query.kind === "reference" ? "references" : "assets";
      const folder = path.join(entry.path, kind);
      await ensureDir(folder);
      const original = safeName(req.query.name, kind === "references" ? "import.bin" : "texture.png");
      let name = original;
      let n = 2;
      while (fssync.existsSync(path.join(folder, name))) {
        const ext = path.extname(original);
        const stem = path.basename(original, ext);
        name = `${stem} ${n++}${ext}`;
      }
      const target = path.join(folder, name);
      await fs.writeFile(target, req.body);
      if (isGlobalProjectPath(entry.path)) {
        const ext = path.extname(name).toLowerCase();
        const bucket = /\.(png|jpe?g|webp|gif|ico|bmp|tga)$/i.test(ext)
          ? "Images"
          : /\.(fbx|obj|glb|gltf|stl|dae)$/i.test(ext)
            ? "FBX Objects"
            : kind === "references"
              ? "Research"
              : "Learning";
        await writeGlobalSnapshot(entry.path, bucket, name, req.body).catch(() => null);
      }
      const rel = `${kind}/${name}`;
      res.json({
        ok: true,
        path: rel,
        name,
        bytes: req.body.length,
        url: `/api/project/${entry.id}/file?path=${encodeURIComponent(rel)}`,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

app.get("/api/project/:id/assets", async (req, res) => {
  try {
    const entry = await loadProjectById(req.params.id);
    const out = [];
    for (const folder of ["assets", "references"]) {
      const dir = path.join(entry.path, folder);
      await ensureDir(dir);
      for (const name of await fs.readdir(dir)) {
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!stat?.isFile()) continue;
        out.push({
          name,
          path: `${folder}/${name}`,
          bytes: stat.size,
          modified: stat.mtime.toISOString(),
          kind: folder === "references" ? "reference" : "asset",
          url: `/api/project/${entry.id}/file?path=${encodeURIComponent(`${folder}/${name}`)}`,
        });
      }
    }
    res.json({ assets: out });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/project/:id/file", async (req, res) => {
  try {
    const target = await resolveProjectFile(req.params.id, String(req.query.path || ""));
    if (!fssync.existsSync(target)) return res.status(404).json({ error: "File not found" });
    res.sendFile(target);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post(
  "/api/project/:id/export",
  express.raw({ type: "*/*", limit: "300mb" }),
  async (req, res) => {
    try {
      const entry = await loadProjectById(req.params.id);
      const format = safeName(req.query.format || "bin", "bin").toLowerCase();
      const base = safeName(req.query.fileName || `export.${format}`, `export.${format}`);
      const name = base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`;
      const folder = path.join(entry.path, "exports");
      await ensureDir(folder);
      let target = path.join(folder, name);
      let n = 2;
      while (fssync.existsSync(target)) {
        target = path.join(folder, `${path.basename(name, `.${format}`)} ${n++}.${format}`);
      }
      await fs.writeFile(target, req.body);
      if (isGlobalProjectPath(entry.path)) {
        await writeGlobalSnapshot(entry.path, "Exports", name, req.body).catch(() => null);
      }
      res.json({
        ok: true,
        path: path.relative(entry.path, target).replace(/\\/g, "/"),
        absolutePath: target,
        bytes: req.body.length,
        url: `/api/project/${entry.id}/file?path=${encodeURIComponent(path.relative(entry.path, target).replace(/\\/g, "/"))}`,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* API: coding workspace                                               */
/* ------------------------------------------------------------------ */

function resolveCodingRoot(dir) {
  if (!dir) throw new Error("Workspace directory is required");
  const root = path.resolve(String(dir));
  if (!fssync.existsSync(root) || !fssync.statSync(root).isDirectory()) {
    throw new Error("Workspace directory does not exist");
  }
  return root;
}

async function codingTree(root, relative, depth, level = 0) {
  const target = path.resolve(root, relative || ".");
  if (!isInside(root, target)) throw new Error("Path outside workspace");
  const entries = await fs.readdir(target, { withFileTypes: true });
  const ignored = new Set(["node_modules", ".git"]);
  const out = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    const node = {
      name: entry.name,
      path: path.relative(root, child).replace(/\\/g, "/"),
      type: entry.isDirectory() ? "dir" : "file",
    };
    if (entry.isDirectory()) {
      if (level < depth) node.children = await codingTree(root, path.relative(root, child), depth, level + 1);
    } else {
      const stat = await fs.stat(child).catch(() => null);
      node.size = stat?.size || 0;
    }
    out.push(node);
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

app.post("/api/coding/connect", async (req, res) => {
  try {
    const { projectId, dir, trusted, force, unityPort } = req.body || {};
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    const root = resolveCodingRoot(dir);
    const state = await startCodingServer(projectId, root, Boolean(trusted), Boolean(force), unityPort ? Number(unityPort) : null);
    const payload = await ocFetch(state, "/config/providers").catch(() => null);
    res.json({
      ok: true,
      dir: root,
      trusted: Boolean(trusted),
      version: state.version,
      unityPort: state.unityPort || null,
      providers: payload ? await normalizeProviders(payload) : [],
      logs: state.logs.slice(-30),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/coding/sessions", async (req, res) => {
  try {
    const projectId = String(req.query.projectId || "");
    const state = codingServers.get(projectId);
    if (!state) return res.json({ sessions: [] });
    const sessions = await ocFetch(state, "/session");
    const list = (Array.isArray(sessions) ? sessions : []).map((session) => ({
      id: session.id,
      title: session.title || "Coding session",
      parentID: session.parentID || null,
      time: session.time || null,
    }));
    res.json({ sessions: list });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/coding/session/:projectId/:sessionId/messages", async (req, res) => {
  try {
    const state = codingServers.get(req.params.projectId);
    if (!state) return res.status(400).json({ error: "Coding workspace is not connected" });
    const data = await ocFetch(state, `/session/${req.params.sessionId}/message?limit=200`);
    res.json({ messages: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/coding/chat", async (req, res) => {
  try {
    const {
      projectId,
      dir,
      trusted = true,
      unityPort = null,
      sessionId,
      text,
      model,
      system = "",
      images = [],
    } = req.body || {};
    if (!projectId || !dir) return res.status(400).json({ error: "projectId and dir are required" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Prompt is empty" });
    let state = codingServers.get(projectId);
    if (!state) {
      state = await startCodingServer(projectId, dir, Boolean(trusted), false, unityPort ? Number(unityPort) : null);
    }
    let sid = sessionId;
    if (!sid) {
      const session = await ocFetch(state, "/session", {
        method: "POST",
        body: JSON.stringify({ title: path.basename(state.root) + " ? Unity" }),
      });
      sid = session.id;
    }
    const parts = [{ type: "text", text: String(text) }];
    for (const image of images.slice(0, 6)) {
      if (!image?.dataUrl) continue;
      parts.push({ type: "file", mime: image.mime || "image/png", filename: image.name || "reference.png", url: image.dataUrl });
    }
    const referenceContext = await referenceContextFor(text);
    const githubContext = await githubContextFor(text);
    const globalContext = await globalLearningContextFor(text);
    const sessionContext = await sessionContextFor(state, text);
    const baseSystem = [
      "You are the coding and Unity agent for AI Creator Studio.",
      knowledgeInstructions,
      globalContext,
      `Workspace root: ${state.root}`,
      `Trusted workspace: ${state.trusted ? "ON - full PC access" : "OFF"}`,
      state.unityPort ? `Unity bridge port: ${state.unityPort}` : "Unity bridge is not connected.",
      "Use coding_* tools for files and commands. Use unity_* tools for Unity state, compile, focus, refresh, play and stop when available.",
      "Work mainly in the selected workspace. Work linearly, one edit or command at a time. Report build/compile results honestly.",
      githubContext,
      referenceContext,
      sessionContext,
      system,
    ].filter(Boolean).join("\n");
    const response = await ocFetch(state, `/session/${sid}/message`, {
      method: "POST",
      body: JSON.stringify({ model, agent: "coder", system: baseSystem, parts }),
    });
    const responseParts = response?.parts || [];
    const responseText = cleanAssistantText(responseParts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"));
    const reasoning = responseParts.filter((part) => part.type === "reasoning").map((part) => part.text).join("\n\n");
    const tools = responseParts.filter((part) => part.type === "tool").map((part) => ({
      name: part.tool,
      status: part.state?.status,
      output: part.state?.output,
      error: part.state?.error,
    }));
    await saveGlobalLearning("Chats", `coding-chat-${sid}`, {
      kind: "coding-chat",
      projectId,
      workspace: state.root,
      unityPort: state.unityPort || null,
      sessionId: sid,
      model,
      prompt: String(text || "").slice(0, 12000),
      response: responseText.slice(0, 20000),
      tools: tools.map((tool) => ({
        name: tool.name,
        status: tool.status,
        output: String(tool.output || "").slice(0, 3000),
        error: tool.error ? String(tool.error).slice(0, 1000) : "",
      })),
      references: referenceContext.slice(0, 4000),
      githubResearch: githubContext.slice(0, 4000),
      globalLearning: globalContext.slice(0, 4000),
      savedAt: new Date().toISOString(),
    }).catch(() => null);
    res.json({ ok: true, sessionId: sid, text: responseText, reasoning, tools });
  } catch (error) {
    log("error", "coding", "chat failed", { message: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/coding/prompt", async (req, res) => {
  try {
    const { projectId, sessionId, text, model, dir, trusted, images = [], githubRepo = null } = req.body || {};
    const state = codingServers.get(projectId);
    if (!state) return res.status(400).json({ error: "Coding workspace is not connected" });
    let recovery = null;
    try {
      recovery = await snapshotCodeWorkspace(state.root, sessionId || "prompt");
      if (recovery) log("info", "coding", "recovery snapshot saved", recovery);
    } catch (error) {
      log("warning", "coding", "recovery snapshot failed", { message: error.message });
    }
    let linkedRepo = null;
    try {
      const entry = await loadProjectById(projectId);
      const meta = await readJson(projectMetaPath(entry.path), {});
      linkedRepo = meta.githubRepo || null;
    } catch {}
    linkedRepo = linkedRepo || githubRepo || null;
    const githubInstructions = [
      linkedRepo
        ? `Linked GitHub repository: ${linkedRepo.fullName} (branch ${linkedRepo.branch || linkedRepo.defaultBranch}). The link manifest is .twix/github.json. Use github_* tools with this owner/repo when the user asks to push or pull, search, read or download files.`
        : "No GitHub repository is linked in the coding sidebar. If the workspace already has a .git/config remote, inspect it before assuming there is none; otherwise do not push or pull until the user links one.",
      "GitHub safety: files over 25 MB and batches over 50 MB are blocked before GitHub can lock the repository. Never push binary textures or audio through github_push_files; use github_download_file or download_url to bring assets into the workspace, then commit small text changes.",
      "GitHub awareness: use github_search_code, github_search_repositories, github_repo_tree and github_read_file to inspect repositories. Pull exact files with github_download_file. Use download_url only when the user asks for an external asset download.",
    ].join("\n");
    let sid = sessionId;
    if (!sid) {
      const session = await ocFetch(state, "/session", { method: "POST", body: JSON.stringify({ title: codingSessionTitle(text) || "Coding session" }) });
      sid = session.id;
    }
    const parts = [{ type: "text", text: String(text || "") }];
    for (const image of images.slice(0, 6)) {
      if (!image?.dataUrl) continue;
      parts.push({ type: "file", mime: image.mime || "image/png", filename: image.name || "reference.png", url: image.dataUrl });
    }
    const referenceContext = await referenceContextFor(text || "");
    const githubContext = await githubContextFor(text || "");
    const globalContext = await globalLearningContextFor(text || "");
    const sessionContext = await sessionContextFor(state, text || "");
    const system = [
      "You are the coding agent for AI Creator Studio.",
      knowledgeInstructions,
      globalContext,
      `Workspace root: ${state.root}`,
      `Trusted workspace: ${state.trusted ? "ON - full PC access" : "OFF"}`,
      "Use coding_* tools only. Work mainly in the selected workspace, linearly, one edit or command at a time. Report build/test results honestly.",
      githubInstructions,
      githubContext,
      referenceContext,
      sessionContext,
    ].filter(Boolean).join("\n");
    await ocFetch(state, `/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ model, agent: "coder", system, parts }),
    });
    await saveGlobalLearning("Chats", `coding-prompt-${sid}`, {
      kind: "coding-prompt",
      projectId,
      workspace: state.root,
      unityPort: state.unityPort || null,
      sessionId: sid,
      model,
      prompt: String(text || "").slice(0, 12000),
      globalLearning: globalContext.slice(0, 4000),
      references: referenceContext.slice(0, 4000),
      githubResearch: githubContext.slice(0, 4000),
      images: images.map((image) => image?.name).filter(Boolean),
      savedAt: new Date().toISOString(),
    }).catch(() => null);
    res.json({ ok: true, sessionId: sid, recovery });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/coding/abort", async (req, res) => {
  try {
    const { projectId, sessionId } = req.body || {};
    const state = codingServers.get(projectId);
    if (!state) return res.status(400).json({ error: "Coding workspace is not connected" });
    await ocFetch(state, `/session/${sessionId}/abort`, { method: "POST" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/coding/session/:projectId/:sessionId", async (req, res) => {
  try {
    const state = codingServers.get(req.params.projectId);
    if (!state) return res.status(400).json({ error: "Coding workspace is not connected" });
    const data = await ocFetch(state, `/session/${req.params.sessionId}/message?limit=200`);
    res.json({ messages: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/coding/files", async (req, res) => {
  try {
    const root = resolveCodingRoot(String(req.query.dir || ""));
    const depth = Math.max(1, Math.min(12, Number(req.query.depth || 6)));
    const children = await codingTree(root, String(req.query.path || "."), depth);
    res.json({ ok: true, root, children });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/coding/file", async (req, res) => {
  try {
    const root = resolveCodingRoot(String(req.query.dir || ""));
    const target = path.resolve(root, String(req.query.path || ""));
    if (!isInside(root, target)) return res.status(400).json({ error: "Path outside workspace" });
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: "File is larger than 2 MB" });
    const content = await fs.readFile(target, "utf8");
    res.json({ ok: true, path: path.relative(root, target).replace(/\\/g, "/"), content, bytes: stat.size });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const codingSizeCache = new Map();

async function codingFolderSize(root) {
  const cached = codingSizeCache.get(root);
  if (cached && Date.now() - cached.at < 30000) return cached;
  let bytes = 0;
  let files = 0;
  let folders = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    folders += 1;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(target);
        bytes += stat.size;
        files += 1;
      } catch {
        /* unreadable file, skip it */
      }
    }
  }
  const result = { bytes, files, folders, at: Date.now() };
  codingSizeCache.set(root, result);
  if (codingSizeCache.size > 60) codingSizeCache.delete(codingSizeCache.keys().next().value);
  return result;
}

app.get("/api/coding/size", async (req, res) => {
  try {
    const root = resolveCodingRoot(String(req.query.dir || ""));
    const size = await codingFolderSize(root);
    res.json({ ok: true, root, bytes: size.bytes, files: size.files, folders: size.folders });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/coding/file", async (req, res) => {
  try {
    const { dir, path: relative, content } = req.body || {};
    const root = resolveCodingRoot(String(dir || ""));
    const target = path.resolve(root, String(relative || ""));
    if (!isInside(root, target)) return res.status(400).json({ error: "Path outside workspace" });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(content ?? ""), "utf8");
    res.json({ ok: true, path: path.relative(root, target).replace(/\\/g, "/"), bytes: Buffer.byteLength(String(content ?? "")) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/coding/entry", async (req, res) => {
  try {
    const root = resolveCodingRoot(String(req.query.dir || ""));
    const relative = String(req.query.path || "").trim();
    if (!relative) return res.status(400).json({ error: "A file or folder path is required." });
    const target = path.resolve(root, relative);
    if (!isInside(root, target) || target === root) {
      return res.status(400).json({ error: "Path outside workspace" });
    }
    const stat = await fs.stat(target);
    await fs.rm(target, { recursive: stat.isDirectory(), force: true });
    res.json({ ok: true, path: path.relative(root, target).replace(/\\/g, "/") });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/coding/status", (req, res) => {
  const out = {};
  for (const [id, state] of codingServers) {
    out[id] = { port: state.port, baseUrl: state.baseUrl, root: state.root, trusted: state.trusted, alive: !state.proc.killed, version: state.version || null };
  }
  res.json({ servers: out });
});

app.get("/api/bun/status", async (req, res) => {
  try {
    const processes = await listBunProcesses();
    res.json({
      ok: true,
      count: processes.length,
      processes: processes.map((item) => ({
        pid: Number(item.ProcessId),
        parentPid: Number(item.ParentProcessId),
        parentAlive: Boolean(item.ParentAlive),
        commandLine: String(item.CommandLine || "").slice(0, 400),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/bun/cleanup", async (req, res) => {
  try {
    const result = await cleanupBunProcesses(Boolean(req.body?.force));
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: provider chat, research, photo                                 */
/* ------------------------------------------------------------------ */

app.post("/api/opencode/chat", async (req, res) => {
  try {
    const { projectId, sessionId, text, model, agent = "research", system = "", images = [] } = req.body || {};
    const state = ocServers.get(projectId || "__global__");
    if (!state) return res.status(400).json({ error: "OpenCode is not connected for this project" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Prompt is empty" });
    let sid = sessionId;
    const abort = new AbortController();
    res.on("close", () => {
      if (res.writableEnded) return;
      abort.abort();
      if (sid) void ocFetch(state, `/session/${sid}/abort`, { method: "POST" }).catch(() => {});
    });
    if (!sid) {
      const sessionTitle = agent === "writer" ? "Writing format" : agent === "photo" ? "Photo vector session" : "Research chat";
      const session = await ocFetch(state, "/session", { method: "POST", body: JSON.stringify({ title: sessionTitle }), signal: abort.signal });
      sid = session.id;
    }
    const parts = [{ type: "text", text: String(text) }];
    for (const image of images.slice(0, 6)) {
      if (!image?.dataUrl) continue;
      parts.push({ type: "file", mime: image.mime || "image/png", filename: image.name || "reference.png", url: image.dataUrl });
    }
    // Writing is a direct rewrite task. Do not run GitHub/local reference/
    // global-learning/session research before it; that made Format slow.
    const isDirectWriter = agent === "writer";
    let referenceContext = "";
    let githubContext = "";
    let webContext = "";
    let globalContext = "";
    let sessionContext = "";
    if (!isDirectWriter) {
      const [refs, github, web, global] = await Promise.all([
        referenceContextFor(text),
        githubContextFor(text),
        agent === "research" ? webContextFor(text) : Promise.resolve(""),
        globalLearningContextFor(text),
      ]);
      referenceContext = refs;
      githubContext = github;
      webContext = web;
      globalContext = global;
      sessionContext = await sessionContextFor(state, text);
    }
    const agentGuard =
      agent === "research"
        ? "You are the research assistant. You have live GitHub tools. Use the available repository search, repo tree, file read, code search and download tools whenever a user asks about a repository or its files. Never claim GitHub is unavailable. Answer in plain markdown with verified links and paths from tool results."
        : agent === "photo"
          ? "You are the photo assistant. You may use GitHub tools for visual research when useful. Answer directly and return SVG artwork when requested."
          : agent === "writer"
            ? "You are the professional writing assistant. Rewrite and format the supplied source directly. Do not browse, search, fetch external data or use tools. Return only the finished, polished text in markdown. Do not explain your process or add emoji unless asked."
            : "";
    const systemWithReferences = isDirectWriter
      ? ""
      : [system, agentGuard, knowledgeInstructions, globalContext, githubContext, referenceContext, webContext, sessionContext]
          .filter(Boolean)
          .join("\n");
    log("info", "chat", "opencode prompt", { projectId, sessionId: sid, agent, model, images: images.length });
    let response;
    try {
      response = await ocFetch(state, `/session/${sid}/message`, {
        method: "POST",
        body: JSON.stringify({
          model,
          // Match a plain OpenCode GUI message for writing. The client text
          // already contains the formatting pre-prompt.
          agent: agent === "writer" ? "build" : agent,
          ...(agent === "writer" ? {} : { system: systemWithReferences }),
          parts,
          ...(agent === "photo" ? { variant: "low", tools: { "*": false } } : {}),
        }),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted || error?.name === "AbortError") throw error;
      log("warning", "chat", "primary agent failed; retrying without images/agent tools", { message: error.message, agent });
      const fallbackParts = parts.filter((part) => part.type !== "file");
      response = await ocFetch(state, `/session/${sid}/message`, {
        method: "POST",
        body: JSON.stringify({
          model,
          agent: agent === "writer" ? "build" : agent === "twix" ? "twix" : agent,
          ...(agent === "writer"
            ? {}
            : {
                system: systemWithReferences,
                ...(agent === "photo" ? { variant: "low" } : {}),
                tools: agent === "research" ? { "*": false, "github_*": true, download_url: true } : { "*": false },
              }),
          parts: fallbackParts.length ? fallbackParts : [{ type: "text", text: String(text) }],
          signal: abort.signal,
        }),
      });
    }
    const responseError = response?.info?.error;
    if (responseError) {
      const detail =
        responseError?.data?.message ||
        responseError?.message ||
        responseError?.name ||
        "The selected model returned an error.";
      throw new Error(String(detail).replace(/\s+/g, " ").slice(0, 500));
    }
    const responseParts = response?.parts || [];
    const responseText = responseParts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
    const reasoning = responseParts.filter((part) => part.type === "reasoning").map((part) => part.text).join("\n\n");
    const tools = responseParts.filter((part) => part.type === "tool").map((part) => ({ name: part.tool, status: part.state?.status, output: part.state?.output }));
    await saveGlobalLearning(
      agent === "research" ? "Research" : agent === "writer" ? "Learning" : "Chats",
      `${agent}-${sid}`,
      {
        kind: agent === "writer" ? "writing-format" : "assistant-chat",
        agent,
        projectId,
        sessionId: sid,
        model,
        prompt: String(text || "").slice(0, 12000),
        response: responseText.slice(0, 20000),
        tools: tools.map((tool) => ({ name: tool.name, status: tool.status, output: String(tool.output || "").slice(0, 3000) })),
        references: referenceContext.slice(0, 4000),
        githubResearch: githubContext.slice(0, 4000),
        webResearch: webContext.slice(0, 4000),
        globalLearning: globalContext.slice(0, 4000),
        savedAt: new Date().toISOString(),
      },
    ).catch(() => null);
    res.json({ ok: true, sessionId: sid, text: responseText, reasoning, tools });
  } catch (error) {
    const message = /fetch failed/i.test(error.message)
      ? "OpenCode did not respond. Reconnect OpenCode and try again."
      : error.message;
    log("error", "chat", "opencode chat failed", { message });
    res.status(500).json({ error: message });
  }
});

app.post("/api/opencode/photo/prompt", async (req, res) => {
  try {
    const { projectId, sessionId, text, model, images = [] } = req.body || {};
    const state = ocServers.get(projectId || "__global__");
    if (!state) return res.status(400).json({ error: "OpenCode is not connected for this project" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Prompt is empty" });

    let sid = sessionId;
    if (!sid) {
      const session = await ocFetch(state, "/session", {
        method: "POST",
        body: JSON.stringify({ title: "Photo vector session" }),
      });
      sid = session.id;
    }

    const parts = [{ type: "text", text: String(text) }];
    for (const image of images.slice(0, 5)) {
      if (!image?.dataUrl) continue;
      parts.push({
        type: "file",
        mime: image.mime || "image/png",
        filename: image.name || "reference.png",
        url: image.dataUrl,
      });
    }

    const system = [
      "You are the photo/vector assistant. Return one complete self-contained SVG in an SVG fenced block. No tools, no scripts, no remote URLs.",
      "Do not write a plan, analysis, summary, or reasoning. Start immediately with the SVG code block and stop after the closing tag.",
      "For multi-layer art, return multiple complete SVG blocks, each preceded by a line LAYER: <name>, ordered background to foreground, and end with <!-- END -->.",
      knowledgeInstructions,
      await globalLearningContextFor(text),
      await githubContextFor(text),
      await referenceContextFor(text),
      await sessionContextFor(state, text),
    ]
      .filter(Boolean)
      .join("\n\n");

    const sendPhotoPrompt = (sendParts) =>
      ocFetch(state, "/session/" + sid + "/prompt_async", {
        method: "POST",
        body: JSON.stringify({ model, agent: "photo", system, variant: "low", parts: sendParts }),
      });
    try {
      await sendPhotoPrompt(parts);
    } catch (error) {
      try {
        await sendPhotoPrompt(parts.filter((part) => part.type !== "file"));
      } catch (fallbackError) {
        await ocFetch(state, "/session/" + sid + "/message", {
          method: "POST",
          body: JSON.stringify({ model, agent: "photo", system, variant: "low", parts }),
        });
      }
    }
    await saveGlobalLearning("Learning", `photo-prompt-${sid}`, {
      kind: "photo-prompt",
      projectId,
      sessionId: sid,
      model,
      prompt: String(text || "").slice(0, 12000),
      images: images.map((image) => image?.name).filter(Boolean),
      globalLearning: (await globalLearningContextFor(text)).slice(0, 3000),
      references: (await referenceContextFor(text)).slice(0, 3000),
      githubResearch: (await githubContextFor(text)).slice(0, 3000),
      savedAt: new Date().toISOString(),
    }).catch(() => null);
    res.json({ ok: true, sessionId: sid });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/photo/smart-save", async (req, res) => {
  try {
    const { projectId, model, promptHistory = [], imageDataUrl, canvas = {}, layers = [] } = req.body || {};
    if (!imageDataUrl || !String(imageDataUrl).startsWith("data:image/")) {
      return res.status(400).json({ error: "A flattened PNG is required." });
    }
    const buffer = Buffer.from(String(imageDataUrl).split(",")[1] || "", "base64");
    if (!buffer.length) return res.status(400).json({ error: "The image data is empty." });

    const prompts = (Array.isArray(promptHistory) ? promptHistory : [])
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-12);
    const layerList = (Array.isArray(layers) ? layers : []).filter((layer) => layer && typeof layer === "object");
    const layerNames = layerList.map((layer) => String(layer.name || "").trim()).filter(Boolean);

    await ensureGlobalProject();
    const imageRoot = path.join(GLOBAL_PROJECT_ROOT, "Images");
    await ensureDir(imageRoot);
    for (const folder of ["icons", "textures", "backgrounds", "logos", "illustrations", "ui", "characters", "patterns", "overlays", "reference"]) {
      await ensureDir(path.join(imageRoot, folder));
    }

    const slug = (value) => String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const readMessageText = (payload) => {
      const items = Array.isArray(payload) ? payload : payload?.parts ? [payload] : payload?.message ? [payload.message] : [];
      return items
        .flatMap((item) => (Array.isArray(item?.parts) ? item.parts : []))
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => String(part.text))
        .join("\n");
    };
    const readJson = (value) => {
      const textValue = String(value || "");
      const start = textValue.indexOf("{");
      const end = textValue.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try { return JSON.parse(textValue.slice(start, end + 1)); } catch { return null; }
    };

    let artworkMeta = null;
    let aiUsed = false;
    const state = ocServers.get(projectId || "__global__");
    if (state && model) {
      let aiSession = null;
      try {
        const created = await ocFetch(state, "/session", {
          method: "POST",
          body: JSON.stringify({ title: "Photo smart save" }),
        });
        aiSession = created?.id;
        if (aiSession) {
          const instructions = [
            "You are cataloguing finished artwork into the Global Learning project.",
            "Analyze the attached flattened artwork and layer images together with the recent user prompts.",
            "Return ONLY one compact JSON object with these keys: category, filename, description, tags.",
            "category must be a short lowercase kebab-case folder name inside the Images folder. Prefer icons, textures, backgrounds, logos, illustrations, ui, characters, patterns, overlays or reference when they fit. Textures includes seamless textures, materials, UV maps, albedo/normal/roughness maps and skin textures. Icons includes app icons, emblems and badges. If nothing fits, create a precise new folder name.",
            "filename must be kebab-case, have no extension and describe what the image actually is.",
            "description is one sentence about the image and how it was made.",
            "tags is an array of 3-8 short lowercase tags.",
            "Recent prompts: " + (prompts.join(" | ") || "none"),
            "Layer names: " + (layerNames.join(", ") || "none"),
          ].join("\n");
          const makeParts = (includeImages) => {
            const parts = [{ type: "text", text: instructions }];
            if (!includeImages) return parts;
            const pushImage = (dataUrl, filename) => {
              if (parts.length >= 8 || !String(dataUrl || "").startsWith("data:image/")) return;
              parts.push({ type: "file", mime: "image/png", filename, url: dataUrl });
            };
            pushImage(imageDataUrl, "artwork.png");
            layerList.slice(0, 6).forEach((layer, index) => {
              pushImage(layer.dataUrl, slug(layer.name) + "-" + (index + 1) + ".png");
            });
            return parts;
          };
          const ask = async (includeImages) => ocFetch(state, "/session/" + aiSession + "/message", {
            method: "POST",
            body: JSON.stringify({ model, agent: "photo", system: "You catalogue finished artwork. Return only one compact JSON object and no prose.", parts: makeParts(includeImages) }),
            signal: AbortSignal.timeout(90000),
          });
          let payload;
          try {
            payload = await ask(true);
          } catch (error) {
            log("warning", "photo", "smart save vision pass failed", { message: error.message });
            payload = await ask(false);
          }
          const parsed = readJson(readMessageText(payload));
          if (parsed && typeof parsed === "object") {
            artworkMeta = parsed;
            aiUsed = true;
          }
        }
      } catch (error) {
        log("warning", "photo", "smart save AI failed", { message: error.message });
      } finally {
        if (aiSession) await ocFetch(state, "/session/" + aiSession, { method: "DELETE" }).catch(() => null);
      }
    }

    const promptText = prompts.join(" ").toLowerCase();
    const fallbackFolder =
      /seamless|texture|material|uv|albedo|normal map|roughness|wood|metal|fabric|skin/.test(promptText) ? "textures" :
      /icon|emblem|badge/.test(promptText) ? "icons" :
      /logo/.test(promptText) ? "logos" :
      /background|backdrop/.test(promptText) ? "backgrounds" :
      /pattern|tile/.test(promptText) ? "patterns" :
      /character|portrait|face/.test(promptText) ? "characters" :
      /ui|interface|button/.test(promptText) ? "ui" :
      "illustrations";
    const folderAliases = { icon: "icons", texture: "textures", background: "backgrounds", logo: "logos", illustration: "illustrations", character: "characters", pattern: "patterns", overlay: "overlays" };
    const requestedFolder = slug(String(artworkMeta?.category || "").split("/").pop()) || fallbackFolder;
    const folder = folderAliases[requestedFolder] || requestedFolder || "illustrations";
    const rawName = String(artworkMeta?.filename || artworkMeta?.name || prompts[prompts.length - 1] || "artwork");
    const lowerName = rawName.toLowerCase();
    const withoutExtension = [".png", ".jpg", ".jpeg", ".webp"].some((ext) => lowerName.endsWith(ext)) ? rawName.slice(0, rawName.lastIndexOf(".")) : rawName;
    const requestedName = slug(withoutExtension) || "artwork";
    const targetDir = path.join(imageRoot, folder);
    await ensureDir(targetDir);
    let base = requestedName;
    let target = path.join(targetDir, base + ".png");
    let suffix = 2;
    while (fssync.existsSync(target)) {
      base = requestedName + "-" + suffix;
      target = path.join(targetDir, base + ".png");
      suffix++;
    }
    await fs.writeFile(target, buffer);

    const layerDir = path.join(targetDir, base + ".layers");
    const savedLayers = [];
    for (let index = 0; index < Math.min(layerList.length, 12); index++) {
      const layer = layerList[index];
      if (!String(layer.dataUrl || "").startsWith("data:image/")) continue;
      const layerName = String(index + 1).padStart(2, "0") + "-" + (slug(layer.name) || "layer") + ".png";
      await ensureDir(layerDir);
      await fs.writeFile(path.join(layerDir, layerName), Buffer.from(String(layer.dataUrl).split(",")[1] || "", "base64"));
      savedLayers.push({ name: layer.name || "Layer " + (index + 1), file: layerName, visible: layer.visible !== false, opacity: layer.opacity ?? 1, blend: layer.blend || "source-over" });
    }

    const relative = path.relative(GLOBAL_PROJECT_ROOT, target).split(path.sep).join("/");
    await writeJsonAtomic(target.slice(0, target.length - 4) + ".json", {
      app: "AI Creator Studio Photo Booth",
      source: "smart-save",
      createdAt: new Date().toISOString(),
      relative,
      category: folder,
      filename: path.basename(target),
      canvas: { width: Number(canvas.width) || null, height: Number(canvas.height) || null },
      promptHistory: prompts,
      description: String(artworkMeta?.description || ""),
      tags: Array.isArray(artworkMeta?.tags) ? artworkMeta.tags.map(String).slice(0, 12) : [],
      aiUsed,
      layers: savedLayers,
    });

    await saveGlobalLearning("Images", `photo-save-${slug(base)}`, {
      kind: "photo-save",
      relative,
      folder,
      filename: path.basename(target),
      promptHistory: prompts,
      description: String(artworkMeta?.description || ""),
      tags: Array.isArray(artworkMeta?.tags) ? artworkMeta.tags.map(String).slice(0, 12) : [],
      canvas,
      layers: savedLayers,
      ai: aiUsed,
      savedAt: new Date().toISOString(),
    }).catch(() => null);
    res.json({
      ok: true,
      path: target,
      relative,
      folder,
      filename: path.basename(target),
      description: String(artworkMeta?.description || ""),
      tags: Array.isArray(artworkMeta?.tags) ? artworkMeta.tags.map(String).slice(0, 12) : [],
      ai: aiUsed,
    });
  } catch (error) {
    log("error", "photo", "smart save failed", { message: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/providers/chat", async (req, res) => {
  try {
    const settings = await getSettings();
    const { provider, messages = [], model: requestedModel } = req.body || {};
    const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message.role === "user");
    const providerPrompt = String(lastUser?.content || "");
    const [githubContext, referenceContext, globalContext] = await Promise.all([
      githubContextFor(providerPrompt),
      referenceContextFor(providerPrompt),
      globalLearningContextFor(providerPrompt),
    ]);
    const knowledge = [knowledgeInstructions, globalContext, githubContext, referenceContext].filter(Boolean).join("\n");
    const contextMessages = knowledge
      ? [{ role: "system", content: knowledge }, ...(Array.isArray(messages) ? messages : [])]
      : messages;
    if (provider === "openai") {
      const apiKey = settings.providers?.openai?.apiKey;
      if (!apiKey) return res.status(400).json({ error: "OpenAI API key is not configured in Settings ? Providers." });
      const model = requestedModel || settings.providers.openai.model || "gpt-4o-mini";
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ model, messages: contextMessages }),
        signal: AbortSignal.timeout(120000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "OpenAI request failed");
      const text = payload.choices?.[0]?.message?.content || "";
      await saveGlobalLearning("Chats", "provider-openai", {
        kind: "assistant-chat", provider: "openai", model, prompt: providerPrompt.slice(0, 12000), response: text.slice(0, 20000), knowledge: knowledge.slice(0, 5000), savedAt: new Date().toISOString(),
      }).catch(() => null);
      return res.json({ ok: true, provider, model, text });
    }
    if (provider === "gemini") {
      const apiKey = settings.providers?.gemini?.apiKey;
      if (!apiKey) return res.status(400).json({ error: "Gemini API key is not configured in Settings ? Providers." });
      const model = requestedModel || settings.providers.gemini.model || "gemini-1.5-flash";
      const contents = contextMessages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: String(message.content || "") }] }));
      const systemText = contextMessages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents,
            systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
          }),
          signal: AbortSignal.timeout(120000),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "Gemini request failed");
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      await saveGlobalLearning("Chats", "provider-gemini", {
        kind: "assistant-chat", provider: "gemini", model, prompt: providerPrompt.slice(0, 12000), response: text.slice(0, 20000), knowledge: knowledge.slice(0, 5000), savedAt: new Date().toISOString(),
      }).catch(() => null);
      return res.json({ ok: true, provider, model, text });
    }
    return res.status(400).json({ error: "Unsupported provider" });
  } catch (error) {
    log("error", "providers", "chat failed", { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

async function generateGeminiImage(apiKey, configuredModel, prompt, size, signal) {
  const aspectRatio = size === "1536x1024" ? "16:9" : size === "1024x1536" ? "9:16" : "1:1";
  const candidates = [];
  const seen = new Set();
  const add = (model, mode) => {
    const key = model + "|" + mode;
    if (!model || seen.has(key)) return;
    seen.add(key);
    candidates.push({ model, mode });
  };
  if (configuredModel) {
    add(configuredModel, /imagen/i.test(configuredModel) ? "predict" : "generateContent");
  }
  add("imagen-3.0-generate-001", "predict");
  add("imagen-3.0-fast-generate-001", "predict");
  add("imagen-4.0-generate-001", "predict");
  add("imagen-4.0-fast-generate-001", "predict");
  add("gemini-2.5-flash-image", "generateContent");
  add("gemini-2.5-flash-image-preview", "generateContent");
  add("gemini-2.0-flash-preview-image-generation", "generateContent");

  const errors = [];
  for (const candidate of candidates) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(candidate.model) +
      ":" +
      candidate.mode +
      "?key=" +
      encodeURIComponent(apiKey);
    const body =
      candidate.mode === "predict"
        ? { instances: [{ prompt: String(prompt) }], parameters: { sampleCount: 1, aspectRatio } }
        : {
            contents: [{ role: "user", parts: [{ text: String(prompt) }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push(candidate.model + ": " + (payload.error?.message || "HTTP " + response.status));
        continue;
      }
      if (candidate.mode === "predict") {
        const b64 = payload.predictions?.[0]?.bytesBase64Encoded;
        if (!b64) {
          errors.push(candidate.model + ": no image data");
          continue;
        }
        return { dataUrl: "data:image/png;base64," + b64, model: candidate.model };
      }
      const parts = payload.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((part) => part.inlineData || part.inline_data);
      const inline = imagePart?.inlineData || imagePart?.inline_data;
      if (!inline?.data) {
        errors.push(candidate.model + ": no inline image data");
        continue;
      }
      return {
        dataUrl: "data:" + (inline.mimeType || inline.mime_type || "image/png") + ";base64," + inline.data,
        model: candidate.model,
      };
    } catch (error) {
      if (error.name === "AbortError") throw error;
      errors.push(candidate.model + ": " + error.message);
    }
  }
  throw new Error("Gemini image generation failed. " + errors.join(" | "));
}

app.post("/api/providers/image", async (req, res) => {
  try {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const signal = AbortSignal.any([AbortSignal.timeout(180000), abort.signal]);
    const settings = await getSettings();
    const { provider, prompt, size = "1024x1024" } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "Prompt is required" });
    if (provider === "openai") {
      const apiKey = settings.providers?.openai?.apiKey;
      if (!apiKey) return res.status(400).json({ error: "OpenAI API key is not configured in Settings ? Providers." });
      const model = settings.providers.openai.imageModel || "gpt-image-1";
      const isGptImage = /^(gpt-image|chatgpt-image)/i.test(model);
      const isDallE3 = /^dall-e-3/i.test(model);
      const isDallE2 = /^dall-e-2/i.test(model);
      const requestSize = isDallE2
        ? "1024x1024"
        : isDallE3
          ? size === "1536x1024"
            ? "1792x1024"
            : size === "1024x1536"
              ? "1024x1792"
              : "1024x1024"
          : size;
      const body = {
        model,
        prompt: String(prompt),
        size: requestSize,
        n: 1,
        ...(isGptImage ? {} : { response_format: "b64_json" }),
      };
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "OpenAI image request failed");
      const item = payload.data?.[0] || {};
      const b64 = item.b64_json;
      const remote = item.url;
      if (!b64 && !remote) throw new Error("OpenAI returned no image data");
      return res.json({ ok: true, provider, model, dataUrl: b64 ? "data:image/png;base64," + b64 : remote });
    }
    if (provider === "gemini") {
      const apiKey = settings.providers?.gemini?.apiKey;
      if (!apiKey) return res.status(400).json({ error: "Gemini API key is not configured in Settings ? Providers." });
      const configured = settings.providers.gemini.imageModel || "gemini-2.5-flash-image";
      const result = await generateGeminiImage(apiKey, configured, prompt, size, signal);
      return res.json({ ok: true, provider, model: result.model, dataUrl: result.dataUrl });
    }
    return res.status(400).json({ error: "Unsupported image provider" });
  } catch (error) {
    log("error", "providers", "image generation failed", { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "Search query is required" });
    const response = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 3D-Creator-Studio/0.1",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("Search request failed (HTTP " + response.status + ")");
    const html = await response.text();
    const results = [];
    const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) && results.length < 12) {
      let url = match[1];
      const redirect = url.match(/[?&]uddg=([^&]+)/);
      if (redirect) url = decodeURIComponent(redirect[1]);
      const title = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      results.push({ title, url, snippet: "" });
    }
    const snippetRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
    let index = 0;
    while ((match = snippetRegex.exec(html)) && index < results.length) {
      results[index].snippet = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      index++;
    }
    log("info", "search", "query", { query, results: results.length });
    res.json({ ok: true, query, results });
  } catch (error) {
    log("error", "search", "failed", { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: diagnostics / logs                                             */
/* ------------------------------------------------------------------ */

app.post("/api/logs/client", (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const day = new Date().toISOString().slice(0, 10);
    for (const entry of entries.slice(0, 200)) {
      appendLog("client-" + day + ".jsonl", {
        ts: entry?.ts || new Date().toISOString(),
        level: entry?.level || "info",
        source: entry?.source || "client",
        message: entry?.message || "",
        data: entry?.data === undefined ? undefined : redact(entry.data),
      });
    }
    res.json({ ok: true, count: entries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    await ensureDir(LOG_DIR);
    const files = [];
    for (const name of await fs.readdir(LOG_DIR)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".old")) continue;
      const target = path.join(LOG_DIR, name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({ name, bytes: stat.size, modified: stat.mtime.toISOString() });
    }
    files.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    res.json({ dir: LOG_DIR, files: files.slice(0, 100) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/logs/tail", async (req, res) => {
  try {
    const name = safeName(String(req.query.file || ""), "app");
    const target = path.join(LOG_DIR, name);
    if (!isInside(LOG_DIR, target)) return res.status(400).json({ error: "Invalid log file" });
    if (!fssync.existsSync(target)) return res.status(404).json({ error: "Log file not found" });
    const limit = Math.min(2000, Math.max(20, Number(req.query.lines || 400)));
    const content = await fs.readFile(target, "utf8");
    const lines = content.trim().split(/\r?\n/).slice(-limit);
    res.json({ file: name, lines, bytes: Buffer.byteLength(content) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/logs/export", async (req, res) => {
  try {
    const name = safeName(String(req.query.file || ""), "app");
    const target = path.join(LOG_DIR, name);
    if (!isInside(LOG_DIR, target) || !fssync.existsSync(target)) return res.status(404).json({ error: "Log not found" });
    res.download(target, name);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: Unity bridge                                                   */
/* ------------------------------------------------------------------ */

const UNITY_PACKAGE_PATH = path.join(APP_ROOT, "unity", "com.twilightstudio.creatorstudio");
const UNITY_FIRST_PORT = 47823;
const UNITY_LAST_PORT = 47843;

function execText(command, timeout = 12000) {
  return new Promise((resolve) => {
    execCommand(command, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : String(stdout || ""));
    });
  });
}

async function unityProcessProjects() {
  const projects = [];
  if (process.platform === "win32") {
    const text = await execText("wmic process where \"name='Unity.exe'\" get CommandLine,ProcessId /format:csv");
    if (!text.trim()) return projects;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("-projectPath")) continue;
      const match = line.match(/-projectPath\s+(?:"([^"]+)"|([^\s,]+))/i);
      if (!match) continue;
      const root = match[1] || match[2];
      const pid = Number(line.trim().split(",").pop());
      if (root) projects.push({ processId: Number.isFinite(pid) ? pid : null, root: path.resolve(root) });
    }
  } else {
    const text = await execText("ps -ax -o pid=,command=");
    for (const line of text.split(/\r?\n/)) {
      if (!/Unity/i.test(line)) continue;
      const match = line.match(/-projectPath\s+(?:"([^"]+)"|([^\s]+))/i);
      if (match) projects.push({ processId: Number(line.trim().split(/\s+/)[0]), root: path.resolve(match[1] || match[2]) });
    }
  }
  return projects;
}

async function unityBridgePing(port) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/ping", { signal: AbortSignal.timeout(450) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function unityBridgePorts() {
  const ports = [];
  for (let port = UNITY_FIRST_PORT; port <= UNITY_LAST_PORT; port++) {
    const state = await unityBridgePing(port);
    if (state?.ok) ports.push({ port, state });
  }
  return ports;
}

app.get("/api/unity/instances", async (req, res) => {
  try {
    const processes = await unityProcessProjects();
    const bridges = await unityBridgePorts();
    const byRoot = new Map();
    for (const item of processes) {
      if (!fssync.existsSync(item.root)) continue;
      const name = path.basename(item.root);
      let version = "";
      try {
        const versionFile = await fs.readFile(path.join(item.root, "ProjectSettings", "ProjectVersion.txt"), "utf8");
        version = (versionFile.match(/m_EditorVersion:\s*(.+)/) || [])[1]?.trim() || "";
      } catch {}
      byRoot.set(item.root.toLowerCase(), {
        root: item.root,
        name,
        version,
        processId: item.processId,
        bridgePort: null,
        bridge: null,
      });
    }
    for (const bridge of bridges) {
      const root = bridge.state.projectRoot ? path.resolve(bridge.state.projectRoot) : "";
      if (!root) continue;
      const key = root.toLowerCase();
      const existing = byRoot.get(key);
      if (existing) {
        existing.bridgePort = bridge.port;
        existing.bridge = bridge.state;
      } else {
        byRoot.set(key, {
          root,
          name: bridge.state.projectName || path.basename(root),
          version: bridge.state.unityVersion || "",
          processId: null,
          bridgePort: bridge.port,
          bridge: bridge.state,
        });
      }
    }
    res.json({
      instances: [...byRoot.values()],
      packagePath: UNITY_PACKAGE_PATH,
      ports: bridges.map((item) => item.port),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/unity/state", async (req, res) => {
  try {
    const port = Number(req.query.port);
    if (!port || port < UNITY_FIRST_PORT || port > UNITY_LAST_PORT) {
      return res.status(400).json({ error: "Invalid Unity bridge port" });
    }
    const response = await fetch("http://127.0.0.1:" + port + "/state", { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return res.status(502).json({ error: "Unity bridge did not respond" });
    res.json(await response.json());
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/unity/viewport", async (req, res) => {
  try {
    const port = Number(req.query.port);
    if (!port || port < UNITY_FIRST_PORT || port > UNITY_LAST_PORT) {
      return res.status(400).json({ error: "Invalid Unity bridge port" });
    }
    const type = req.query.type === "game" ? "game" : "scene";
    const width = Math.max(320, Math.min(1280, Number(req.query.w || 640)));
    const height = Math.max(180, Math.min(720, Number(req.query.h || 360)));
    const response = await fetch("http://127.0.0.1:" + port + "/viewport?type=" + type + "&w=" + width + "&h=" + height, {
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    res.status(response.status).type("application/json").send(text);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/unity/command", async (req, res) => {
  try {
    const port = Number(req.query.port);
    if (!port || port < UNITY_FIRST_PORT || port > UNITY_LAST_PORT) {
      return res.status(400).json({ error: "Invalid Unity bridge port" });
    }
    const response = await fetch("http://127.0.0.1:" + port + "/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    res.status(response.status).type("application/json").send(text);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: references                                                     */
/* ------------------------------------------------------------------ */

function globalReferencesDir() {
  return path.join(DATA_DIR, "references");
}

async function listReferenceFiles(dir, urlPrefix) {
  await ensureDir(dir);
  const out = [];
  for (const name of await fs.readdir(dir)) {
    const target = path.join(dir, name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) continue;
    out.push({
      name,
      path: name,
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
      url: urlPrefix + encodeURIComponent(name),
    });
  }
  return out;
}

const REFERENCE_INDEX_FILE = () => path.join(DATA_DIR, "reference-index.json");
const REFERENCE_NOTES_FILE = () => path.join(DATA_DIR, "reference-index.md");

function tokenizeReference(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/i)
    .filter((word) => word.length > 2)
    .slice(0, 120);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadReferenceIndex() {
  return readJson(REFERENCE_INDEX_FILE(), { updatedAt: null, entries: [] });
}

async function scanReferenceFolder(folder, entries) {
  const root = path.resolve(folder.path);
  if (!fssync.existsSync(root) || !fssync.statSync(root).isDirectory()) return;
  entries.push({
    id: "folder:" + folder.id,
    type: "folder",
    sourceId: folder.id,
    title: folder.label,
    path: root,
    keywords: tokenizeReference(folder.label + " " + root),
    summary: "Local reference folder: " + folder.label,
    text: root,
    updatedAt: new Date().toISOString(),
  });
  let count = 0;
  const walk = async (dir, depth) => {
    if (depth > 4 || count > 2000) return;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (count > 2000) break;
      if (name.startsWith(".") || name === "node_modules") continue;
      const target = path.join(dir, name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      count++;
      const relative = path.relative(root, target).replace(/\\/g, "/");
      const ext = path.extname(name).toLowerCase();
      const textExt = /\.(txt|md|markdown|json|js|ts|tsx|jsx|css|html|xml|yml|yaml|csv|cs|cpp|c|h|py|sh|bat|ps1|ini|log)$/i.test(ext);
      let text = "";
      if (textExt && stat.size < 512 * 1024) {
        text = await fs.readFile(target, "utf8").catch(() => "");
      }
      entries.push({
        id: "file:" + folder.id + ":" + relative,
        type: "file",
        sourceId: folder.id,
        title: name,
        path: relative,
        folderId: folder.id,
        folderLabel: folder.label,
        bytes: stat.size,
        keywords: tokenizeReference(folder.label + " " + relative + " " + text.slice(0, 4000)),
        summary: textExt ? stripHtml(text).slice(0, 500) : "Reference file: " + name,
        text: text.slice(0, 8000),
        updatedAt: new Date().toISOString(),
      });
    }
  };
  await walk(root, 0);
}

async function scanReferenceLink(link, entries, maxDepth = 1) {
  const visited = new Set();
  let count = 0;
  const crawl = async (url, depth, label) => {
    if (visited.has(url) || count > 12) return;
    visited.add(url);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "3D-Creator-Studio/0.2 reference indexer" },
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) return;
      const type = response.headers.get("content-type") || "";
      if (!type.includes("text/html") && !type.includes("text/plain")) return;
      const html = (await response.text()).slice(0, 900000);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const descriptionMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      const text = stripHtml(html).slice(0, 12000);
      const title = stripHtml(titleMatch?.[1] || label || url).slice(0, 180);
      entries.push({
        id: "url:" + url,
        type: "url",
        sourceId: link.id,
        title,
        url,
        linkId: link.id,
        linkLabel: link.label,
        keywords: tokenizeReference(link.label + " " + title + " " + text.slice(0, 5000)),
        summary: stripHtml(descriptionMatch?.[1] || text.slice(0, 500)).slice(0, 700),
        text: text.slice(0, 12000),
        depth,
        updatedAt: new Date().toISOString(),
      });
      count++;
      if (depth <= 0) return;
      const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
        .map((match) => {
          try { return new URL(match[1], url).toString(); } catch { return ""; }
        })
        .filter((next) => next.startsWith("http") && !next.includes("#") && new URL(next).origin === new URL(url).origin)
        .filter((next, index, all) => all.indexOf(next) === index)
        .slice(0, 8);
      for (const next of links) await crawl(next, depth - 1, title);
    } catch {}
  };
  await crawl(link.url, Math.max(0, Math.min(2, maxDepth)), link.label);
}

async function scanLinksConcurrently(links, entries) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < links.length) {
      const link = links[cursor++];
      await scanReferenceLink(link, entries, 1);
    }
  };
  const workers = Math.max(1, Math.min(6, links.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function writeReferenceIndex(index) {
  await writeJsonAtomic(REFERENCE_INDEX_FILE(), index);
  const notes = [
    "# Reference Index",
    "",
    "Generated " + index.updatedAt,
    "",
    ...index.entries.slice(0, 5000).map((entry) => {
      const location = entry.url || entry.path || "";
      return "- [" + entry.type + "] **" + entry.title + "** - " + location + "\n  " + (entry.summary || "");
    }),
  ].join("\n");
  await fs.writeFile(REFERENCE_NOTES_FILE(), notes, "utf8");
}

async function scanReferenceSources() {
  const settings = await getSettings();
  const entries = [];
  const folders = settings.references?.folders || [];
  const links = settings.references?.links || [];
  for (const folder of folders) await scanReferenceFolder(folder, entries);
  await scanLinksConcurrently(links, entries);
  const index = { updatedAt: new Date().toISOString(), entries: entries.slice(0, 5000) };
  await writeReferenceIndex(index);
  return index;
}

async function scanReferenceLinksOnly() {
  const settings = await getSettings();
  const existing = await loadReferenceIndex();
  const kept = (existing.entries || []).filter((entry) => entry.type !== "url");
  const links = settings.references?.links || [];
  const entries = [];
  await scanLinksConcurrently(links, entries);
  const index = { updatedAt: new Date().toISOString(), entries: [...kept, ...entries].slice(0, 5000) };
  await writeReferenceIndex(index);
  return { index, links: links.length, urlEntries: entries.length };
}

function searchReferenceEntries(index, query, limit = 10) {
  const terms = tokenizeReference(query);
  if (!terms.length || !index?.entries?.length) return [];
  const scored = index.entries.map((entry) => {
    const haystack = (entry.title + " " + (entry.path || "") + " " + (entry.url || "") + " " + (entry.keywords || []).join(" ") + " " + (entry.summary || "") + " " + (entry.text || "")).toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (entry.title?.toLowerCase().includes(term)) score += 5;
      if ((entry.keywords || []).includes(term)) score += 3;
      if (haystack.includes(term)) score += 1;
    }
    return { entry, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(30, limit)));
  return scored.map((item) => item.entry);
}

const globalLearningFilesCache = { at: 0, files: [] };
const globalLearningContextCache = new Map();

async function listRecentGlobalFiles() {
  if (Date.now() - globalLearningFilesCache.at < 30000) return globalLearningFilesCache.files;
  const folders = ["Learning", "Chats", "Code", "Research", "Logs", "Scenes", "Exports", "FBX Objects", "Humanoids", "Images"];
  const files = [];
  const walk = async (dir, folder, depth) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await walk(target, folder, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(target).catch(() => null);
      if (stat) found.push({ path: target, name: entry.name, folder, mtime: stat.mtimeMs, size: stat.size });
    }
    found.sort((a, b) => b.mtime - a.mtime);
    files.push(...found.slice(0, 24));
  };
  for (const folder of folders) {
    const dir = path.join(GLOBAL_PROJECT_ROOT, folder);
    if (fssync.existsSync(dir)) await walk(dir, folder, folder === "Images" ? 2 : 0);
  }
  globalLearningFilesCache.at = Date.now();
  globalLearningFilesCache.files = files;
  return files;
}

async function globalFileText(file) {
  try {
    if (file.size > 512 * 1024) return "";
    if (/\.json$/i.test(file.name)) {
      const raw = await fs.readFile(file.path, "utf8");
      try {
        const data = JSON.parse(raw);
        const parts = [
          data.title,
          data.prompt,
          data.summary,
          data.description,
          data.response,
          data.text,
          data.content,
          data.command,
          data.name,
          data.kind,
          data.tool,
          data.args ? JSON.stringify(data.args).slice(0, 800) : "",
          data.error,
        ];
        if (Array.isArray(data.tags)) parts.push(...data.tags);
        if (Array.isArray(data.files)) parts.push(...data.files);
        if (Array.isArray(data.warnings)) parts.push(...data.warnings);
        if (Array.isArray(data.messages)) {
          for (const message of data.messages.slice(-6)) parts.push(message?.text);
        }
        if (Array.isArray(data.tools)) {
          for (const tool of data.tools.slice(-6)) parts.push(tool?.name, tool?.summary);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 2400);
      } catch {
        return raw.replace(/\s+/g, " ").slice(0, 1600);
      }
    }
    if (/\.(md|txt)$/i.test(file.name)) {
      const raw = await fs.readFile(file.path, "utf8");
      return raw.replace(/\s+/g, " ").slice(0, 1600);
    }
    return "";
  } catch {
    return "";
  }
}

async function globalLearningContextFor(query) {
  try {
    const terms = tokenizeReference(query).filter((term) => term.length > 2).slice(0, 10);
    const cacheKey = terms.join("|") || "__recent__";
    const cached = globalLearningContextCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 30000) return cached.text;
    const files = await listRecentGlobalFiles();
    const hits = [];
    for (const file of files.slice(0, 140)) {
      const text = await globalFileText(file);
      const haystack = (file.name + " " + text).toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      if (terms.length && score === 0) continue;
      hits.push({ ...file, score, excerpt: text.slice(0, 260) });
    }
    hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    const selected = hits.slice(0, terms.length ? 7 : 6);
    if (!selected.length) return "";
    const lines = [
      "Global Learning library (permanent project memory; review this before running tools):",
      "- Library root: " + GLOBAL_PROJECT_ROOT,
      ...selected.map((hit) => "- [" + hit.folder + "] " + hit.name + (hit.excerpt ? ": " + hit.excerpt : "")),
    ];
    const artifacts = [];
    for (const folder of ["FBX Objects", "Humanoids", "Scenes", "Exports", "Images"]) {
      const names = files
        .filter((file) => file.folder === folder)
        .slice(0, 3)
        .map((file) => file.name);
      if (names.length) artifacts.push(folder + ": " + names.join(", "));
    }
    if (artifacts.length) lines.push("", "Reusable artifacts: " + artifacts.join(" | "));
    try {
      const meta = await readJson(projectMetaPath(GLOBAL_PROJECT_ROOT), null);
      const notes = [
        ...(Array.isArray(meta?.contextNotes) ? meta.contextNotes.slice(-5) : []),
        ...(Array.isArray(meta?.importNotes) ? meta.importNotes.slice(-3) : []),
      ].filter(Boolean);
      if (notes.length) lines.push("", "Recent project context: " + notes.join(" | ").slice(0, 1400));
    } catch {}
    const text = lines.join("\n").slice(0, 6000);
    globalLearningContextCache.set(cacheKey, { at: Date.now(), text });
    if (globalLearningContextCache.size > 80) {
      for (const key of globalLearningContextCache.keys()) {
        if (globalLearningContextCache.size <= 60) break;
        globalLearningContextCache.delete(key);
      }
    }
    return text;
  } catch {
    return "";
  }
}

const knowledgeInstructions = [
  "Knowledge briefing: the context below combines the permanent Global Learning library, indexed local references and public GitHub research. Review it before running commands or changing files. It records what this app has already built, which tools and prompts worked, existing assets and the user's conventions.",
  "If the request is about code, Unity, 3D models, materials, shaders, textures, writing or a public repository, inspect the relevant local reference paths and use github_search_repositories, github_search_code, github_repo_tree and github_read_file to verify public repositories before acting. Never claim GitHub is unavailable. Verify before copying.",
].join("\n");

async function referenceContextFor(query) {
  try {
    const index = await loadReferenceIndex();
    const matches = searchReferenceEntries(index, query, 8);
    if (!matches.length) return "";
    return "Reference index matches (optional background; use only if directly relevant and stay on the user's request):\n" +
      matches.map((entry) => "- " + entry.type + ": " + entry.title + " - " + (entry.url || entry.path || "") + (entry.summary ? "\n  " + String(entry.summary).slice(0, 260) : "")).join("\n");
  } catch {
    return "";
  }
}

async function sessionContextFor(state, query) {
  try {
    const terms = tokenizeReference(query);
    if (!terms.length || !state) return "";
    const sessions = await ocFetch(state, "/session").catch(() => []);
    const recent = (Array.isArray(sessions) ? sessions : []).slice(0, 16);
    const hits = [];
    for (const session of recent) {
      if (hits.length >= 6) break;
      const messages = await ocFetch(state, "/session/" + session.id + "/message?limit=30").catch(() => []);
      const text = (Array.isArray(messages) ? messages : [])
        .flatMap((message) => (message.parts || []).filter((part) => part.type === "text").map((part) => part.text || ""))
        .join("\n");
      const lower = text.toLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) hits.push({ title: session.title || "Untitled session", score, text: text.slice(0, 900) });
    }
    if (!hits.length) return "";
    hits.sort((a, b) => b.score - a.score);
    return "Related prior OpenCode session history (use only when it helps; do not repeat it blindly):\n" +
      hits.slice(0, 4).map((hit) => "- " + hit.title + ": " + hit.text.replace(/\s+/g, " ").slice(0, 500)).join("\n");
  } catch {
    return "";
  }
}

app.get("/api/references", async (req, res) => {
  try {
    const settings = await getSettings();
    const globalDir = globalReferencesDir();
    const global = await listReferenceFiles(globalDir, "/api/references/file?path=");
    let project = [];
    let projectDir = "";
    let projectLinks = [];
    if (req.query.projectId) {
      const entry = await loadProjectById(String(req.query.projectId));
      projectDir = path.join(entry.path, "references");
      project = await listReferenceFiles(projectDir, `/api/project/${entry.id}/file?path=references/`);
      const meta = await readJson(projectMetaPath(entry.path), {});
      projectLinks = meta.referenceLinks || [];
    }
    let projectFolders = [];
    if (req.query.projectId) {
      const entry = await loadProjectById(String(req.query.projectId));
      const meta = await readJson(projectMetaPath(entry.path), {});
      projectFolders = meta.referenceFolders || [];
    }
    res.json({
      global,
      project,
      links: settings.references?.links || [],
      projectLinks,
      folders: settings.references?.folders || [],
      projectFolders,
      globalDir,
      projectDir,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  "/api/references/upload",
  express.raw({ type: "*/*", limit: "100mb" }),
  async (req, res) => {
    try {
      const scope = req.query.scope === "project" ? "project" : "global";
      let dir;
      if (scope === "project") {
        const entry = await loadProjectById(String(req.query.projectId));
        dir = path.join(entry.path, "references");
      } else {
        dir = globalReferencesDir();
      }
      await ensureDir(dir);
      const name = safeName(req.query.name, "reference");
      let target = path.join(dir, name);
      let n = 2;
      while (fssync.existsSync(target)) {
        const ext = path.extname(name);
        target = path.join(dir, `${path.basename(name, ext)} ${n++}${ext}`);
      }
      await fs.writeFile(target, req.body);
      const base = path.basename(target);
      res.json({
        ok: true,
        name: base,
        scope,
        bytes: req.body.length,
        url:
          scope === "project"
            ? `/api/project/${req.query.projectId}/file?path=${encodeURIComponent("references/" + base)}`
            : `/api/references/file?path=${encodeURIComponent(base)}`,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

app.post("/api/references/scan", async (req, res) => {
  try {
    const index = await scanReferenceSources();
    res.json({ ok: true, updatedAt: index.updatedAt, count: index.entries.length, entries: index.entries.slice(0, 40) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/references/scan-links", async (req, res) => {
  try {
    const result = await scanReferenceLinksOnly();
    res.json({
      ok: true,
      updatedAt: result.index.updatedAt,
      count: result.index.entries.length,
      links: result.links,
      urlEntries: result.urlEntries,
      entries: result.index.entries.filter((entry) => entry.type === "url").slice(0, 60),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/references/search", async (req, res) => {
  try {
    const query = String(req.query.q || "");
    const index = await loadReferenceIndex();
    const matches = searchReferenceEntries(index, query, Number(req.query.limit || 12));
    res.json({ ok: true, query, updatedAt: index.updatedAt, count: index.entries.length, matches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/references/index", async (req, res) => {
  try {
    const index = await loadReferenceIndex();
    res.json({ ok: true, updatedAt: index.updatedAt, count: index.entries?.length || 0, entries: (index.entries || []).slice(0, 300) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/references/folder", async (req, res) => {
  try {
    const { scope = "global", projectId, label, path: folderPath } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: "Folder path is required" });
    const resolved = path.resolve(String(folderPath));
    if (!fssync.existsSync(resolved) || !fssync.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: "Folder does not exist" });
    }
    const folder = {
      id: "folder_" + randomUUID().slice(0, 8),
      label: safeName(label || path.basename(resolved), "Reference folder"),
      path: resolved,
      createdAt: new Date().toISOString(),
    };
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(projectId);
      const meta = await readJson(projectMetaPath(entry.path), {});
      meta.referenceFolders = [folder, ...(meta.referenceFolders || [])];
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
    } else {
      const settings = await getSettings();
      await saveSettings({ references: { folders: [folder, ...(settings.references?.folders || [])] } });
    }
    res.json({ ok: true, folder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/references/folder", async (req, res) => {
  try {
    const { id, scope = "global", projectId } = req.query;
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(String(projectId));
      const meta = await readJson(projectMetaPath(entry.path), {});
      meta.referenceFolders = (meta.referenceFolders || []).filter((folder) => folder.id !== id);
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
    } else {
      const settings = await getSettings();
      await saveSettings({ references: { folders: (settings.references?.folders || []).filter((folder) => folder.id !== id) } });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/references/folder/files", async (req, res) => {
  try {
    const { scope = "global", projectId, id } = req.query;
    const settings = await getSettings();
    let folders = settings.references?.folders || [];
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(String(projectId));
      const meta = await readJson(projectMetaPath(entry.path), {});
      folders = meta.referenceFolders || [];
    }
    const folder = folders.find((item) => item.id === id);
    if (!folder) return res.status(404).json({ error: "Reference folder not found" });
    const root = path.resolve(folder.path);
    const files = [];
    const walk = async (dir, depth) => {
      if (depth > 2 || files.length > 300) return;
      for (const name of await fs.readdir(dir)) {
        if (files.length > 300) break;
        if (name.startsWith(".") || name === "node_modules") continue;
        const target = path.join(dir, name);
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) await walk(target, depth + 1);
        else files.push({ name, path: path.relative(root, target).replace(/\\/g, "/"), bytes: stat.size });
      }
    };
    await walk(root, 0);
    res.json({ ok: true, folder, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/references/read", async (req, res) => {
  try {
    const { scope = "global", projectId, id, path: relative } = req.query;
    const settings = await getSettings();
    let folders = settings.references?.folders || [];
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(String(projectId));
      const meta = await readJson(projectMetaPath(entry.path), {});
      folders = meta.referenceFolders || [];
    }
    const folder = folders.find((item) => item.id === id);
    if (!folder) return res.status(404).json({ error: "Reference folder not found" });
    const root = path.resolve(folder.path);
    const target = path.resolve(root, String(relative || ""));
    if (!isInside(root, target)) return res.status(400).json({ error: "Path outside reference folder" });
    const stat = await fs.stat(target);
    if (stat.size > 1024 * 1024) return res.status(400).json({ error: "File is larger than 1 MB" });
    const content = await fs.readFile(target, "utf8");
    res.json({ ok: true, folder, path: path.relative(root, target).replace(/\\/g, "/"), content, bytes: stat.size });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/references/link", async (req, res) => {
  try {
    const { scope = "global", projectId, label, url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return res.status(400).json({ error: "A valid http(s) URL is required" });
    }
    const link = {
      id: `ref_${randomUUID().slice(0, 8)}`,
      label: safeName(label || url, "Reference"),
      url: String(url),
      createdAt: new Date().toISOString(),
    };
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(projectId);
      const meta = await readJson(projectMetaPath(entry.path), {});
      meta.referenceLinks = [link, ...(meta.referenceLinks || [])];
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
    } else {
      const settings = await getSettings();
      await saveSettings({ references: { links: [link, ...(settings.references?.links || [])] } });
    }
    res.json({ ok: true, link });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/references/link", async (req, res) => {
  try {
    const { id, scope = "global", projectId } = req.query;
    if (scope === "project" && projectId) {
      const entry = await loadProjectById(String(projectId));
      const meta = await readJson(projectMetaPath(entry.path), {});
      meta.referenceLinks = (meta.referenceLinks || []).filter((link) => link.id !== id);
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
    } else {
      const settings = await getSettings();
      await saveSettings({
        references: { links: (settings.references?.links || []).filter((link) => link.id !== id) },
      });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/references/fetch", async (req, res) => {
  try {
    const url = String(req.body?.url || "");
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "A valid http(s) URL is required" });
    const response = await fetch(url, {
      headers: { "User-Agent": "3D-Creator-Studio/0.1 reference reader" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    const raw = await response.text();
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20000);
    res.json({ ok: true, url, status: response.status, contentType: response.headers.get("content-type"), text });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/references/file", async (req, res) => {
  try {
    const target = path.resolve(globalReferencesDir(), String(req.query.path || ""));
    if (!isInside(globalReferencesDir(), target)) return res.status(400).json({ error: "Invalid path" });
    if (!fssync.existsSync(target)) return res.status(404).json({ error: "File not found" });
    res.sendFile(target);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: reference bundles (export / import)                            */
/* ------------------------------------------------------------------ */

const REFERENCE_EXPORT_KIND = "3d-creator-studio-references";

async function encodeReferenceFiles(dir, limitFiles = 200, limitBytes = 60 * 1024 * 1024) {
  const out = [];
  let total = 0;
  if (!fssync.existsSync(dir)) return out;
  for (const name of await fs.readdir(dir)) {
    if (out.length >= limitFiles || total >= limitBytes) break;
    const target = path.join(dir, name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) continue;
    total += stat.size;
    if (total > limitBytes) break;
    out.push({ name, base64: (await fs.readFile(target)).toString("base64") });
  }
  return out;
}

async function collectReferenceExport(includeFiles) {
  const settings = await getSettings();
  const index = await readProjectIndex();
  const projects = [];
  for (const entry of index.projects || []) {
    const meta = await readJson(projectMetaPath(entry.path), null);
    if (!meta) continue;
    const links = meta.referenceLinks || [];
    const folders = meta.referenceFolders || [];
    if (!links.length && !folders.length) continue;
    projects.push({ id: entry.id, name: meta.name || entry.name || "Project", path: entry.path, links, folders });
  }
  const bundle = {
    kind: REFERENCE_EXPORT_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "AI Creator Studio by Twilight Studio",
    global: { links: settings.references?.links || [], folders: settings.references?.folders || [] },
    projects,
  };
  if (!includeFiles) return bundle;
  const files = { global: await encodeReferenceFiles(globalReferencesDir()), projects: {} };
  for (const project of projects) {
    files.projects[project.id] = await encodeReferenceFiles(path.join(project.path, "references"));
  }
  bundle.files = files;
  return bundle;
}

function referenceIdentity(kind, item) {
  if (!item) return "";
  if (kind === "link") return String(item.url || "").trim().toLowerCase().replace(/\/$/, "");
  return path.resolve(String(item.path || "")).toLowerCase();
}

function mergeReferenceList(kind, existing, incoming, replace) {
  const source = Array.isArray(incoming) ? incoming : [];
  const cleaned = [];
  const seen = new Set();
  for (const item of source) {
    if (!item) continue;
    const identity = referenceIdentity(kind, item);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    cleaned.push({
      ...item,
      id: item.id || (kind === "link" ? "ref_" : "folder_") + randomUUID().slice(0, 8),
      createdAt: item.createdAt || new Date().toISOString(),
    });
  }
  if (replace) return { list: cleaned, added: cleaned.length };
  const existingList = Array.isArray(existing) ? existing : [];
  const existingIdentities = new Set(existingList.map((item) => referenceIdentity(kind, item)).filter(Boolean));
  const keep = [];
  const existingSeen = new Set();
  for (const item of existingList) {
    const identity = referenceIdentity(kind, item);
    if (!identity || existingSeen.has(identity) || seen.has(identity)) continue;
    existingSeen.add(identity);
    keep.push(item);
  }
  // Only count sources that were not already registered.
  const added = cleaned.filter((item) => !existingIdentities.has(referenceIdentity(kind, item))).length;
  return { list: [...cleaned, ...keep], added };
}

async function writeReferenceBundleFile(dir, name, base64) {
  await ensureDir(dir);
  const safe = safeName(name, "reference");
  const buffer = Buffer.from(String(base64 || ""), "base64");
  let target = path.join(dir, safe);
  let n = 2;
  while (fssync.existsSync(target)) {
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && existing.equals(buffer)) return path.basename(target);
    const ext = path.extname(safe);
    target = path.join(dir, `${path.basename(safe, ext)} ${n++}${ext}`);
  }
  await fs.writeFile(target, buffer);
  return path.basename(target);
}

app.get("/api/references/export", async (req, res) => {
  try {
    const includeFiles = req.query.includeFiles === "1";
    const bundle = await collectReferenceExport(includeFiles);
    const fileName = `3d-creator-studio-references-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/references/import", async (req, res) => {
  try {
    const bundle = req.body?.bundle || req.body;
    const mode = req.body?.mode === "replace" ? "replace" : "merge";
    if (!bundle || typeof bundle !== "object" || !bundle.global) {
      return res.status(400).json({ error: "This file is not an AI Creator Studio reference bundle." });
    }
    const settings = await getSettings();
    const linkResult = mergeReferenceList("link", settings.references?.links || [], bundle.global?.links || [], mode === "replace");
    const folderResult = mergeReferenceList("folder", settings.references?.folders || [], bundle.global?.folders || [], mode === "replace");
    await saveSettings({ references: { links: linkResult.list, folders: folderResult.list } });

    const projectAdded = { count: 0 };
    const projectFiles = bundle.files?.projects || {};
    const index = await readProjectIndex();
    for (const incoming of Array.isArray(bundle.projects) ? bundle.projects : []) {
      let entry = (index.projects || []).find((item) => item.id === incoming.id);
      if (!entry && incoming.name) entry = (index.projects || []).find((item) => item.name === incoming.name);
      if (!entry) continue;
      const meta = await readJson(projectMetaPath(entry.path), null);
      if (!meta) continue;
      const projectLinkResult = mergeReferenceList("link", meta.referenceLinks || [], incoming.links || [], mode === "replace");
      const projectFolderResult = mergeReferenceList("folder", meta.referenceFolders || [], incoming.folders || [], mode === "replace");
      meta.referenceLinks = projectLinkResult.list;
      meta.referenceFolders = projectFolderResult.list;
      await writeJsonAtomic(projectMetaPath(entry.path), meta);
      projectAdded.count++;
      for (const exported of projectFiles[incoming.id] || []) {
        await writeReferenceBundleFile(path.join(entry.path, "references"), exported.name, exported.base64);
      }
    }

    let fileCount = 0;
    for (const exported of bundle.files?.global || []) {
      await writeReferenceBundleFile(globalReferencesDir(), exported.name, exported.base64);
      fileCount++;
    }

    const missingFolders = (folderResult.list || [])
      .filter((folder) => !fssync.existsSync(folder.path))
      .map((folder) => folder.path);

    res.json({
      ok: true,
      mode,
      added: {
        links: linkResult.added,
        folders: folderResult.added,
        projects: projectAdded.count,
        files: fileCount,
      },
      missingFolders,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: app data (export / import / merge another install)             */
/* ------------------------------------------------------------------ */

const { registerDataPortability } = await import("./data-portability.mjs");
registerDataPortability(app, {
  DATA_DIR,
  APP_ROOT,
  APP_VERSION,
  getSettings,
  saveSettings,
  readProjectIndex,
  writeProjectIndex,
  projectMetaPath,
  projectScenePath,
  globalReferencesDir,
  loadReferenceIndex,
  scanReferenceSources,
  mergeReferenceList,
  writeReferenceBundleFile,
  ensureDir,
});

/* ------------------------------------------------------------------ */
/* API: GitHub                                                         */
/* ------------------------------------------------------------------ */

app.get("/api/github/status", async (req, res) => {
  try {
    res.json(await githubAccountStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/github/token", async (req, res) => {
  try {
    const body = req.body || {};
    const token = String(body.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "A fine-grained GitHub token is required." });
    }
    if (token.length < 20) {
      return res.status(400).json({
        error: "That does not look like a GitHub token. Fine-grained tokens start with github_pat_.",
      });
    }
    if (githubTokenKind(token) !== "fine-grained") {
      return res.status(400).json({
        error:
          "Only fine-grained GitHub tokens are supported. Use the setup button to create one; it starts with github_pat_.",
      });
    }
    const { data, headers } = await githubRequest("/user", { token, fallback: false });
    const settings = await getSettings();
    const next = {
      ...settings.github,
      token,
      tokenKind: "fine-grained",
      login: data.login,
      name: data.name || data.login,
      avatarUrl: data.avatar_url,
      scopes: githubScopes(headers),
      writeToken: "",
      writeLogin: "",
    };
    if (!next.defaultOwner) next.defaultOwner = data.login;
    await saveSettings({ github: next });
    log("info", "github", "fine-grained token saved", { login: data.login });
    res.json(await githubAccountStatus());
  } catch (error) {
    const status = error?.status === 401 ? 401 : 400;
    res.status(status).json({ error: `GitHub rejected the token: ${error.message}` });
  }
});

/**
 * Live permission probe for the saved token: what can it read, and can it
 * actually push to the repo the studio publishes to? Fine-grained tokens need
 * Contents: read and write (plus Administration to create repositories).
 */
app.get("/api/github/permissions", async (req, res) => {
  try {
    const settings = await getSettings();
    if (!githubPrimaryToken(settings)) {
      return res.status(400).json({ ok: false, connected: false, error: "Save a fine-grained GitHub token first." });
    }
    const user = await githubRequest("/user", { settings, fallback: false });
    const report = {
      ok: true,
      login: user.data?.login || "",
      tokenKind: "fine-grained",
      scopes: githubScopes(user.headers),
      canListOwnRepos: false,
      canReadSelectedRepo: null,
      canPush: null,
      canCreateRepos: null,
      repo: "",
      privateRepo: null,
      defaultOwner: settings.github?.defaultOwner || user.data?.login || "",
      defaultRepo: settings.github?.defaultRepo || "",
      tokenPreview: githubMaskToken(settings.github?.token),
      error: "",
    };

    try {
      const list = await githubApi(
        "/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator,organization_member",
        { settings },
      );
      report.canListOwnRepos = Array.isArray(list.data);
      const requested = String(req.query.repo || settings.github?.defaultRepo || "").trim();
      const candidate = requested || (Array.isArray(list.data) ? list.data[0]?.full_name : "") || "";
      if (candidate) {
        const info = await githubApi(`/repos/${candidate}`, { settings }).catch(() => null);
        if (info?.data) {
          const permissions = info.data.permissions || {};
          report.repo = info.data.full_name || candidate;
          report.privateRepo = Boolean(info.data.private);
          report.canReadSelectedRepo = true;
          report.canPush = Boolean(permissions.push || permissions.admin || permissions.maintain);
          report.canCreateRepos = report.canPush;
        } else {
          report.repo = candidate;
          report.canReadSelectedRepo = false;
          report.canPush = false;
        }
      }
    } catch (error) {
      report.error = error.message;
    }

    res.json(report);
  } catch (error) {
    res.status(400).json({ ok: false, connected: false, error: error.message });
  }
});

app.delete("/api/github/token", async (req, res) => {
  try {
    const which = String(req.query.which || "all");
    const settings = await getSettings();
    const next = { ...settings.github };
    if (which === "all" || which === "primary") {
      next.token = "";
      next.tokenKind = "";
      next.login = "";
      next.name = "";
      next.avatarUrl = "";
      next.scopes = [];
    }
    if (which === "all" || which === "write") {
      next.writeToken = "";
      next.writeLogin = "";
    }
    await saveSettings({ github: next });
    log("info", "github", "token removed", { which });
    res.json(await githubAccountStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/github/repos", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.max(1, Math.min(100, Number(req.query.perPage || 60)));
    const sort = ["updated", "pushed", "full_name", "created"].includes(String(req.query.sort))
      ? String(req.query.sort)
      : "updated";
    const affiliation = String(req.query.affiliation || "owner,collaborator,organization_member");
    const { data } = await githubApi(
      `/user/repos?per_page=${perPage}&page=${page}&sort=${sort}&affiliation=${encodeURIComponent(affiliation)}`,
    );
    const repos = (Array.isArray(data) ? data : []).map(normalizeGitHubRepo).filter(Boolean);
    res.json({ ok: true, repos, page, hasMore: repos.length === perPage });
  } catch (error) {
    res.status(error.status === 401 ? 401 : 502).json({ error: error.message });
  }
});

app.post("/api/github/repos", async (req, res) => {
  try {
    const { name, description = "", private: isPrivate = false, autoInit = true, org = "" } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!cleanName) return res.status(400).json({ error: "Repository name is required." });
    const endpoint = org ? `/orgs/${encodeURIComponent(String(org).trim())}/repos` : "/user/repos";
    const { data } = await githubApi(endpoint, {
      method: "POST",
      body: {
        name: cleanName,
        description: String(description || "").slice(0, 350),
        private: Boolean(isPrivate),
        auto_init: Boolean(autoInit),
      },
    });
    res.json({ ok: true, repo: normalizeGitHubRepo(data) });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { data } = await githubApi(githubRepoApi(owner, repo));
    const branches = await githubApi(githubRepoApi(owner, repo, "/branches?per_page=100")).catch(() => ({ data: [] }));
    res.json({
      ok: true,
      repo: normalizeGitHubRepo(data),
      branches: (Array.isArray(branches.data) ? branches.data : []).map((branch) => branch.name),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo/branches", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { data } = await githubApi(githubRepoApi(owner, repo, "/branches?per_page=100"));
    res.json({
      ok: true,
      branches: (Array.isArray(data) ? data : []).map((branch) => ({
        name: branch.name,
        sha: branch.commit?.sha || "",
        protected: Boolean(branch.protected),
      })),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo/tree", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const ref = String(req.query.ref || "");
    const dirPath = String(req.query.path || "");
    const recursive = req.query.recursive === "1";
    if (recursive) {
      let treeRef = ref;
      if (!treeRef) {
        const info = await githubApi(githubRepoApi(owner, repo));
        treeRef = info.data.default_branch || "main";
      }
      const { data } = await githubApi(
        githubRepoApi(owner, repo, `/git/trees/${encodeURIComponent(treeRef)}?recursive=1`),
      );
      const entries = (data?.tree || [])
        .filter((entry) => entry.type === "blob" || entry.type === "tree")
        .map((entry) => ({
          name: String(entry.path || "").split("/").pop() || entry.path,
          path: entry.path,
          type: entry.type === "tree" ? "dir" : entry.type === "blob" ? "file" : entry.type,
          size: entry.size,
          sha: entry.sha,
          html_url: `https://github.com/${owner}/${repo}/${entry.type === "tree" ? "tree" : "blob"}/${encodeURIComponent(treeRef)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
        }));
      return res.json({ ok: true, entries, ref: treeRef, path: "" });
    }
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const { data } = await githubApi(githubRepoApi(owner, repo, `/contents/${githubEncodePath(dirPath)}${query}`));
    const entries = (Array.isArray(data) ? data : []).map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : entry.type,
      size: entry.size,
      sha: entry.sha,
      html_url: entry.html_url,
    }));
    res.json({ ok: true, entries, ref, path: dirPath });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo/file", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const filePath = String(req.query.path || "");
    const ref = String(req.query.ref || "");
    if (!filePath) return res.status(400).json({ error: "path is required" });
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const { data } = await githubApi(githubRepoApi(owner, repo, `/contents/${githubEncodePath(filePath)}${query}`));
    if (!data || Array.isArray(data) || data.type !== "file") {
      return res.status(400).json({ error: "The selected path is not a file." });
    }
    const buffer = Buffer.from(String(data.content || ""), data.encoding === "base64" ? "base64" : "utf8");
    const isBinary = buffer.includes(0);
    res.json({
      ok: true,
      path: data.path,
      name: data.name,
      ref,
      content: isBinary ? "" : buffer.toString("utf8"),
      binary: isBinary,
      bytes: data.size || buffer.length,
      sha: data.sha,
      htmlUrl: data.html_url,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo/download", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const filePath = String(req.query.path || "");
    const ref = String(req.query.ref || "");
    if (!filePath) return res.status(400).json({ error: "path is required" });
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const { data } = await githubApi(githubRepoApi(owner, repo, `/contents/${githubEncodePath(filePath)}${query}`));
    if (!data || Array.isArray(data) || data.type !== "file") {
      return res.status(400).json({ error: "The selected path is not a file." });
    }
    const buffer = Buffer.from(String(data.content || ""), data.encoding === "base64" ? "base64" : "utf8");
    if (buffer.length > GITHUB_MAX_FILE_BYTES) {
      return res.status(413).json({
        error: `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. Downloads are capped at 25 MB for workspace safety.`,
      });
    }
    res.json({
      ok: true,
      path: data.path,
      name: data.name,
      ref,
      bytes: buffer.length,
      base64: buffer.toString("base64"),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/repos/:owner/:repo/zip", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const settings = await getSettings();
    const token = settings.github?.token || process.env.TWIX_GITHUB_TOKEN || "";
    if (!token) return res.status(400).json({ error: "Connect GitHub before downloading repository archives." });
    const ref = String(req.query.ref || "HEAD");
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "User-Agent": "AI-Creator-Studio",
        },
        signal: AbortSignal.timeout(180000),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(response.status).json({ error: text.slice(0, 300) || "GitHub ZIP download failed." });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > GITHUB_MAX_ZIP_BYTES) {
      return res.status(413).json({ error: "Repository archive is larger than the 200 MB limit." });
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${owner}-${repo}.zip"`);
    res.send(buffer);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/github/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const type = String(req.query.type || "both");
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 12)));
    if (!query) return res.status(400).json({ error: "A search query is required." });
    const repositories = [];
    const code = [];
    let codeError = "";
    if (type !== "code") {
      const repoResult = await githubApi(
        `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`,
      ).catch((error) => ({ error }));
      for (const item of repoResult?.data?.items || []) {
        repositories.push({
          id: `repo:${item.full_name}`,
          title: item.full_name,
          url: item.html_url,
          repo: item.full_name,
          description: item.description || "",
          kind: "repository",
          stars: item.stargazers_count,
          language: item.language,
        });
      }
      if (repoResult?.error) codeError = repoResult.error.message;
    }
    if (type !== "repositories") {
      const codeResult = await githubApi(
        `/search/code?q=${encodeURIComponent(query)}&per_page=${limit}`,
        { accept: "application/vnd.github.text-match+json" },
      ).catch((error) => ({ error }));
      for (const item of codeResult?.data?.items || []) {
        const fragment = item.text_matches?.[0]?.fragment || "";
        code.push({
          id: `code:${item.repository?.full_name || ""}:${item.path}`,
          title: item.path,
          url: item.html_url,
          repo: item.repository?.full_name || "",
          path: item.path,
          description: fragment.replace(/\s+/g, " ").slice(0, 400),
          kind: "code",
        });
      }
      if (codeResult?.error) codeError = codeError || codeResult.error.message;
    }
    res.json({ ok: true, query, repositories, code, codeError });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/** Git's content hash: sha1("blob <bytes>\0" + content). */
function githubBlobSha(buffer) {
  return createHash("sha1").update("blob " + buffer.length + "\0").update(buffer).digest("hex");
}

/** Upload a blob and return its sha (Git Data API). */
async function githubCreateBlob(owner, repo, buffer, binary) {
  const { data } = await githubApi(githubRepoApi(owner, repo, "/git/blobs"), {
    method: "POST",
    timeoutMs: 180000,
    body: binary
      ? { content: buffer.toString("base64"), encoding: "base64" }
      : { content: buffer.toString("utf8"), encoding: "utf-8" },
  });
  return data.sha;
}

/** Encode a branch name without escaping the slashes GitHub expects. */
function githubRefPath(branch) {
  return String(branch || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Upload blobs one at a time. GitHub's secondary rate limit is triggered by
 * bursty concurrent writes to the same repository, so serial uploads with a
 * short pause are slower but far more reliable for a 100 MB project.
 *
 * A failed file is recorded and skipped instead of aborting the whole commit:
 * every file that is under the limits still gets pushed.
 */
async function githubUploadBlobs(owner, repo, changes) {
  const entries = [];
  const failed = [];
  let consecutiveRateLimits = 0;
  for (let index = 0; index < changes.length; index++) {
    const item = changes[index];
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    const binary = item.buffer.includes(0);
    try {
      const sha = await githubCreateBlob(owner, repo, item.buffer, binary);
      entries.push({ path: item.path, mode: "100644", type: "blob", sha });
      consecutiveRateLimits = 0;
    } catch (error) {
      failed.push({ path: item.path, bytes: item.buffer.length, reason: error.message });
      log("warning", "github", "blob upload failed", { path: item.path, message: error.message });
      if (githubIsRateLimited(error)) {
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= 3) {
          for (const rest of changes.slice(index + 1)) {
            failed.push({
              path: rest.path,
              bytes: rest.buffer.length,
              reason: "Skipped after repeated GitHub secondary rate limits. Push again in a few minutes.",
            });
          }
          break;
        }
      } else {
        consecutiveRateLimits = 0;
      }
    }
  }
  return { entries, failed };
}

async function githubDefaultBranch(owner, repo) {
  try {
    const { data } = await githubApi(githubRepoApi(owner, repo));
    return data?.default_branch || "main";
  } catch {
    return "main";
  }
}

/**
 * Read the remote branch before a push.
 *
 * `exists` says whether refs/heads/<branch> is real. When it is missing we base
 * the new commit on the repository's default branch so a first push to a new
 * branch never replaces the existing history. The whole tree is loaded so
 * unchanged files can be skipped by blob hash.
 */
async function githubReadBranchState(owner, repo, branch) {
  const state = {
    branch,
    exists: false,
    headSha: "",
    baseTreeSha: "",
    baseBranch: "",
    truncated: false,
    remote: new Map(),
  };
  try {
    const ref = await githubApi(githubRepoApi(owner, repo, "/git/ref/heads/" + githubRefPath(branch)));
    state.exists = true;
    state.headSha = ref.data?.object?.sha || "";
  } catch (error) {
    if (error.status !== 404 && error.status !== 409 && error.status !== 422) throw error;
  }
  if (!state.headSha) {
    try {
      const info = await githubApi(githubRepoApi(owner, repo));
      const fallbackBranch = info.data?.default_branch || "";
      if (fallbackBranch && fallbackBranch !== branch) {
        const ref = await githubApi(
          githubRepoApi(owner, repo, "/git/ref/heads/" + githubRefPath(fallbackBranch)),
        );
        state.headSha = ref.data?.object?.sha || "";
        state.baseBranch = state.headSha ? fallbackBranch : "";
      }
    } catch {
      /* Empty repository: the first commit gets no parents. */
    }
  }
  if (state.headSha) {
    let tree;
    try {
      tree = await githubApi(
        githubRepoApi(owner, repo, "/git/trees/" + encodeURIComponent(state.headSha) + "?recursive=1"),
        { timeoutMs: 90000 },
      );
    } catch (error) {
      throw new Error(
        "Could not read the remote file tree (" +
          error.message +
          "). Sync stopped before changing anything so remote files cannot be deleted by mistake.",
      );
    }
    state.baseTreeSha = tree.data?.sha || "";
    state.truncated = Boolean(tree.data?.truncated);
    for (const item of tree.data?.tree || []) {
      if (item.type === "blob" && item.path) state.remote.set(item.path, item.sha);
    }
    if (state.truncated) {
      log("warning", "github", "remote tree was truncated; deletions disabled", { owner, repo, branch });
    }
  }
  return state;
}

/** Write one tree + one commit and move (or create) the branch ref. */
async function githubCommitTree(owner, repo, branch, message, entries, state, options = {}) {
  if (!entries.length && state.headSha) {
    return { commitSha: state.headSha, commitUrl: "", skipped: true };
  }
  const treeBody = { tree: entries };
  if (!options.clean && state.baseTreeSha) treeBody.base_tree = state.baseTreeSha;
  let treeData;
  try {
    ({ data: treeData } = await githubApi(githubRepoApi(owner, repo, "/git/trees"), {
      method: "POST",
      timeoutMs: 120000,
      body: treeBody,
    }));
  } catch (error) {
    throw new Error("Could not create the remote tree (" + error.message + ").");
  }
  const commitBody = { message, tree: treeData.sha };
  if (state.headSha) commitBody.parents = [state.headSha];
  let commitData;
  try {
    ({ data: commitData } = await githubApi(githubRepoApi(owner, repo, "/git/commits"), {
      method: "POST",
      timeoutMs: 120000,
      body: commitBody,
    }));
  } catch (error) {
    throw new Error("Could not create the commit (" + error.message + ").");
  }
  if (state.exists) {
    try {
      await githubApi(githubRepoApi(owner, repo, "/git/refs/heads/" + githubRefPath(branch)), {
        method: "PATCH",
        body: { sha: commitData.sha, force: false },
      });
    } catch (error) {
      if (error.status === 409 || error.status === 422) {
        throw new Error("The branch moved while pushing. Run the push again to sync the newest changes.");
      }
      throw new Error("Could not update the branch (" + error.message + ").");
    }
  } else {
    await githubApi(githubRepoApi(owner, repo, "/git/refs"), {
      method: "POST",
      body: { ref: "refs/heads/" + branch, sha: commitData.sha },
    });
  }
  return { commitSha: commitData.sha, commitUrl: commitData.html_url || "", skipped: false };
}

app.post("/api/github/pull", async (req, res) => {
  try {
    const {
      owner,
      repo,
      root: requestedRoot,
      path: remotePath = "",
      ref = "",
      overwrite = false,
    } = req.body || {};
    if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required." });
    if (!requestedRoot) return res.status(400).json({ error: "A workspace root is required." });

    const root = path.resolve(String(requestedRoot));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      return res.status(404).json({ error: "Workspace folder not found: " + root });
    }

    const targetBranch = String(ref || "").trim() || (await githubDefaultBranch(owner, repo));
    const { data } = await githubApi(
      githubRepoApi(owner, repo, "/git/trees/" + encodeURIComponent(targetBranch) + "?recursive=1"),
      { timeoutMs: 90000 },
    );
    const prefix = String(remotePath || "").replace(/^\/+|\/+$/g, "");
    const entries = (data?.tree || []).filter((entry) => entry.type === "blob" && entry.path);
    const selected = entries.filter(
      (entry) => !prefix || entry.path === prefix || entry.path.startsWith(prefix + "/"),
    );
    if (!selected.length) {
      return res.status(404).json({
        error: prefix ? "No files were found at " + prefix + "." : "The repository is empty.",
      });
    }
    if (selected.length > 4000) {
      return res.status(413).json({
        error:
          "This pull contains " +
          selected.length +
          " files. The safe limit is 4000 files per pull; select a subfolder instead.",
      });
    }

    const pulled = [];
    const skipped = [];
    const failed = [];
    let bytes = 0;
    const MAX_PULL_BYTES = 200 * 1024 * 1024;

    for (const entry of selected) {
      const relative =
        prefix && entry.path === prefix
          ? path.basename(entry.path)
          : prefix
            ? entry.path.slice(prefix.length + 1)
            : entry.path;
      const dest = path.resolve(root, relative);
      if (dest !== root && !dest.startsWith(root + path.sep)) {
        failed.push({ path: entry.path, reason: "Invalid path." });
        continue;
      }
      if (String(relative).split(/[\\/]/).some((part) => part === "node_modules" || part === ".git")) {
        skipped.push({ path: entry.path, reason: "Ignored folder." });
        continue;
      }
      if (Number(entry.size || 0) > GITHUB_MAX_FILE_BYTES) {
        skipped.push({
          path: entry.path,
          bytes: entry.size,
          reason: "Larger than the 25 MB safe file limit.",
        });
        continue;
      }
      if (!overwrite && fssync.existsSync(dest)) {
        skipped.push({ path: entry.path, reason: "Already exists locally." });
        continue;
      }
      try {
        const blob = await githubApi(
          githubRepoApi(owner, repo, "/git/blobs/" + encodeURIComponent(entry.sha)),
          { timeoutMs: 120000 },
        );
        const buffer = Buffer.from(String(blob.data?.content || ""), "base64");
        if (buffer.length > GITHUB_MAX_FILE_BYTES) {
          skipped.push({
            path: entry.path,
            bytes: buffer.length,
            reason: "Larger than the 25 MB safe file limit.",
          });
          continue;
        }
        if (bytes + buffer.length > MAX_PULL_BYTES) {
          return res.status(413).json({
            error:
              "This pull exceeds the 200 MB safe limit. Pull a smaller folder, or pull the rest in a second pass.",
          });
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buffer);
        pulled.push(relative);
        bytes += buffer.length;
      } catch (error) {
        failed.push({ path: entry.path, reason: error.message });
      }
      if (pulled.length > 0 && pulled.length % 20 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }

    log("info", "github", "pulled repository directory", {
      owner,
      repo,
      branch: targetBranch,
      path: prefix,
      root,
      pulled: pulled.length,
      skipped: skipped.length,
      failed: failed.length,
      bytes,
    });

    res.json({
      ok: true,
      ref: targetBranch,
      path: prefix,
      root,
      pulled,
      skipped,
      failed,
      bytes,
      total: selected.length,
    });
  } catch (error) {
    log("error", "github", "pull failed", { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/github/push", async (req, res) => {
  try {
    const { owner, repo, branch = "", message = "Update from AI Creator Studio", files = [] } = req.body || {};
    if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required." });
    const list = Array.isArray(files) ? files.filter((item) => item && item.path) : [];
    if (!list.length) return res.status(400).json({ error: "At least one file is required." });

    const sized = list.map((item) => ({
      ...item,
      path: String(item.path).replace(/\\/g, "/").replace(/^\/+/, ""),
      bytes: Buffer.byteLength(String(item.content ?? ""), "utf8"),
    }));
    const badPath = sized.find(
      (item) => !item.path || item.path.split("/").some((part) => part === ".." || part === ""),
    );
    if (badPath) return res.status(400).json({ error: "Invalid file path: " + String(badPath.path || "") });
    const oversized = sized.find((item) => item.bytes > GITHUB_MAX_FILE_BYTES);
    if (oversized) {
      return res.status(413).json({
        error: `Push blocked: ${oversized.path} is ${(oversized.bytes / 1024 / 1024).toFixed(1)} MB. The safe limit is 25 MB per file; GitHub rejects much larger files and can make the repository unpushable.`,
      });
    }
    const totalBytes = sized.reduce((total, item) => total + item.bytes, 0);
    if (totalBytes > GITHUB_MAX_BATCH_BYTES) {
      return res.status(413).json({
        error: `Push blocked: the batch is ${(totalBytes / 1024 / 1024).toFixed(1)} MB. The safe limit is 50 MB per push; split the files into smaller commits.`,
      });
    }

    const targetBranch = String(branch || "").trim() || (await githubDefaultBranch(owner, repo));
    let repoSizeKb = null;
    let warning = "";
    try {
      const repoInfo = await githubApi(githubRepoApi(owner, repo));
      repoSizeKb = Number(repoInfo.data?.size || 0);
      if (repoSizeKb * 1024 > GITHUB_REPO_WARN_BYTES) {
        warning = `This repository is ${(repoSizeKb / 1024 / 1024).toFixed(2)} GB. Large repositories risk push limits; prefer small, focused commits.`;
      }
    } catch {}

    const state = await githubReadBranchState(owner, repo, targetBranch);
    const changed = [];
    const unchanged = [];
    for (const item of sized) {
      const buffer = Buffer.from(String(item.content ?? ""), "utf8");
      const sha = githubBlobSha(buffer);
      if (state.remote.get(item.path) === sha) {
        unchanged.push(item.path);
        continue;
      }
      changed.push({ path: item.path, buffer });
    }

    const { entries, failed } = await githubUploadBlobs(owner, repo, changed);

    let commit = { commitSha: state.headSha, commitUrl: "", skipped: true };
    if (entries.length || !state.headSha) {
      commit = await githubCommitTree(
        owner,
        repo,
        targetBranch,
        message + (entries.length ? " (" + entries.length + " changes)" : ""),
        entries,
        state,
      );
    }
    const pushedSet = new Set(entries.map((entry) => entry.path));
    const pushedPaths = [...pushedSet];
    let pushedBytes = changed
      .filter((item) => pushedSet.has(item.path))
      .reduce((total, item) => total + item.buffer.length, 0);
    const results = [
      ...pushedPaths.map((path) => ({ path, status: "pushed", commit: commit.commitSha })),
      ...failed.map((item) => ({ path: item.path, status: "failed", error: item.reason })),
      ...unchanged.map((path) => ({ path, status: "unchanged", commit: commit.commitSha })),
    ];

    log("info", "github", "files pushed", {
      owner,
      repo,
      branch: targetBranch,
      pushed: pushedPaths.length,
      failed: failed.length,
      unchanged: unchanged.length,
      bytes: pushedBytes,
      commit: commit.commitSha,
    });

    res.json({
      ok: true,
      branch: targetBranch,
      commit: commit.commitSha,
      commitUrl: commit.commitUrl,
      results,
      pushed: pushedPaths,
      failed,
      unchanged,
      pushedBytes,
      repoSizeKb,
      warning,
      limits: {
        maxFileBytes: GITHUB_MAX_FILE_BYTES,
        maxBatchBytes: GITHUB_MAX_BATCH_BYTES,
        repoWarnBytes: GITHUB_REPO_WARN_BYTES,
      },
    });
  } catch (error) {
    const settings = await getSettings().catch(() => null);
    const hint = settings
      ? githubWriteHint(error, settings, req.body?.owner && req.body?.repo ? `${req.body.owner}/${req.body.repo}` : "")
      : "";
    res.status(502).json({ error: hint ? `${error.message} - ${hint}` : error.message });
  }
});

app.post("/api/github/sync", async (req, res) => {
  try {
    const {
      projectId,
      root: requestedRoot,
      owner,
      repo,
      branch = "",
      message = "Sync from AI Creator Studio",
      deleteMissing = true,
      clean = true,
      dryRun = false,
    } = req.body || {};
    if ((!projectId && !requestedRoot) || !owner || !repo) {
      return res.status(400).json({ error: "A workspace root (or projectId), owner and repo are required." });
    }
    // The studio sends the folder selected in the coding hierarchy. Only fall
    // back to projectId for older callers, otherwise the global project could
    // be pushed instead of the workspace the user is looking at.
    let root = "";
    if (requestedRoot) {
      root = path.resolve(String(requestedRoot));
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) return res.status(404).json({ error: "Workspace folder not found: " + root });
    } else {
      const project = await loadProjectById(projectId);
      if (!project?.path) return res.status(404).json({ error: "Project not found." });
      root = path.resolve(project.path);
    }
    const cleanMode = clean !== false;
    const targetBranch = String(branch || "").trim() || (await githubDefaultBranch(owner, repo));
    const ignoreDirs = new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      "release",
      "out",
      "coverage",
      ".twix",
      ".cache",
      ".vite",
      "tmp",
      "temp",
      "logs",
      "code-recovery",
    ]);
    const ignoreExt = new Set([".exe", ".dll", ".pdb", ".zip", ".7z", ".rar"]);
    const REPORT_FILE = "github_notpushed.txt";
    const ignoreFiles = new Set([REPORT_FILE]);
    const ignoredRuleNames = new Set();
    // Windows folder names are case-insensitive: "Logs" must match "logs".
    const isIgnoredDir = (name) => ignoreDirs.has(String(name || "").toLowerCase());
    const isIgnoredRemotePath = (remotePath) => {
      const parts = String(remotePath || "").split("/");
      if (parts.some((part) => isIgnoredDir(part))) return true;
      const fileName = String(parts[parts.length - 1] || "").toLowerCase();
      if (ignoreFiles.has(fileName)) return true;
      return ignoreExt.has(path.extname(fileName).toLowerCase());
    };

    // 1. Collect local files.
    const files = [];
    let skippedIgnored = 0;
    let totalBytes = 0;
    const walk = async (current, rel = "") => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (isIgnoredDir(entry.name)) {
          ignoredRuleNames.add(entry.name + "/");
          skippedIgnored++;
          continue;
        }
        const absolute = path.join(current, entry.name);
        const relative = rel ? rel + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          await walk(absolute, relative);
          continue;
        }
        if (!entry.isFile()) {
          skippedIgnored++;
          continue;
        }
        if (entry.name.toLowerCase() === REPORT_FILE) {
          // Regenerated below and included in the same commit.
          continue;
        }
        if (ignoreExt.has(path.extname(entry.name).toLowerCase())) {
          ignoredRuleNames.add(path.extname(entry.name).toLowerCase());
          skippedIgnored++;
          continue;
        }
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat?.isFile()) continue;
        files.push({ path: relative, absolute, bytes: stat.size });
        totalBytes += stat.size;
      }
    };
    await walk(root);

    const largeFiles = files
      .filter((item) => item.bytes > GITHUB_MAX_FILE_BYTES)
      .map((item) => ({
        path: item.path,
        bytes: item.bytes,
        mb: Number((item.bytes / 1024 / 1024).toFixed(2)),
      }));
    // Files above the safe per-file limit are never sent to GitHub. They are
    // reported in github_notpushed.txt instead of blocking the whole push.
    const allowed = files
      .filter((item) => item.bytes <= GITHUB_MAX_FILE_BYTES)
      .sort((a, b) => a.path.localeCompare(b.path));
    // A single tree commit comfortably handles a few thousand entries; this is a
    // guard rail, not a target.
    const MAX_SYNC_FILES = 4000;
    const filesTruncated = allowed.length > MAX_SYNC_FILES;
    if (cleanMode && filesTruncated) {
      return res.status(413).json({
        error:
          "This workspace has " +
          allowed.length +
          " eligible files, above the " +
          MAX_SYNC_FILES +
          "-file limit for one clean push. Nothing was changed. Raise the limit or exclude folders first.",
      });
    }
    const selected = filesTruncated ? allowed.slice(0, MAX_SYNC_FILES) : allowed;
    const cappedFiles = filesTruncated ? allowed.slice(MAX_SYNC_FILES) : [];
    const localPaths = new Set(selected.map((item) => item.path));
    // The generated report is always part of the workspace and must survive
    // clean-mode deletion.
    localPaths.add("github_notpushed.txt");

    // 2. Read the remote branch state.
    const state = await githubReadBranchState(owner, repo, targetBranch);
    const canDelete = Boolean(deleteMissing) && !state.truncated && !filesTruncated;

    // 3. Upload only what changed.
    const changed = [];
    const unchanged = [];
    for (const item of selected) {
      const buffer = await fs.readFile(item.absolute).catch(() => null);
      if (!buffer) {
        skippedIgnored++;
        continue;
      }
      const sha = githubBlobSha(buffer);
      if (state.remote.get(item.path) === sha) {
        unchanged.push(item.path);
        continue;
      }
      changed.push({ path: item.path, buffer });
    }

    if (dryRun) {
      const wouldDelete = cleanMode
        ? [...state.remote.keys()].filter((remotePath) => !localPaths.has(remotePath))
        : canDelete
          ? [...state.remote.keys()].filter(
              (remotePath) => !localPaths.has(remotePath) && !isIgnoredRemotePath(remotePath),
            )
          : [];
      return res.json({
        ok: true,
        dryRun: true,
        clean: cleanMode,
        workspace: root,
        branch: targetBranch,
        pushed: changed.map((item) => item.path),
        unchanged,
        deleted: wouldDelete,
        pushedBytes: changed.reduce((total, item) => total + item.buffer.length, 0),
        totalFiles: allowed.length,
        totalBytes,
        truncated: filesTruncated,
        maxFiles: MAX_SYNC_FILES,
        remoteTreeTruncated: state.truncated,
        deleteSkipped: Boolean(deleteMissing) && !canDelete,
        skippedLarge: largeFiles,
        skippedIgnored,
      });
    }

    const { entries, failed } = await githubUploadBlobs(owner, repo, changed);
    const pushedSet = new Set(entries.map((entry) => entry.path));
    const pushedPaths = [...pushedSet];
    const pushedBytes = changed
      .filter((item) => pushedSet.has(item.path))
      .reduce((total, item) => total + item.buffer.length, 0);

    // 4. Deletions. Clean mode rebuilds the tree without base_tree, so every
    // remote file that is not part of this workspace disappears in the same
    // commit. Files that already exist remotely are kept for entries that could
    // not be uploaded (oversized / failed), so a temporary error never destroys
    // the user's last good copy.
    const deleted = [];
    if (cleanMode) {
      for (const remotePath of state.remote.keys()) {
        if (!localPaths.has(remotePath)) deleted.push(remotePath);
      }
      const entryPaths = new Set(entries.map((entry) => entry.path));
      for (const pathName of unchanged) {
        const sha = state.remote.get(pathName);
        if (sha && !entryPaths.has(pathName)) {
          entries.push({ path: pathName, mode: "100644", type: "blob", sha });
          entryPaths.add(pathName);
        }
      }
      for (const item of failed) {
        const sha = state.remote.get(item.path);
        if (sha && !entryPaths.has(item.path)) {
          entries.push({ path: item.path, mode: "100644", type: "blob", sha });
          entryPaths.add(item.path);
        }
      }
      for (const item of largeFiles) {
        const sha = state.remote.get(item.path);
        if (sha && !entryPaths.has(item.path)) {
          entries.push({ path: item.path, mode: "100644", type: "blob", sha });
          entryPaths.add(item.path);
        }
      }
    } else if (canDelete) {
      for (const remotePath of state.remote.keys()) {
        if (localPaths.has(remotePath)) continue;
        if (remotePath.startsWith(".twix/") || remotePath.startsWith(".git/")) continue;
        if (isIgnoredRemotePath(remotePath)) continue;
        entries.push({ path: remotePath, mode: "100644", type: "blob", sha: null });
        deleted.push(remotePath);
      }
    }


    // 6. Build the "not pushed" report and leave it in the workspace so the user
    // can see exactly what is still missing from GitHub.
    const notPushed = [];
    for (const item of largeFiles) {
      notPushed.push({
        path: item.path,
        bytes: item.bytes,
        reason: "Larger than the 25 MB safe per-file limit (" + item.mb + " MB)",
      });
    }
    for (const item of cappedFiles) {
      notPushed.push({
        path: item.path,
        bytes: item.bytes,
        reason: "Exceeds the " + MAX_SYNC_FILES + "-file limit for one sync",
      });
    }
    for (const item of failed) {
      notPushed.push({ path: item.path, bytes: item.bytes, reason: item.reason });
    }
    notPushed.sort((a, b) => a.path.localeCompare(b.path));

    const formatMb = (bytes) => ((Number(bytes) || 0) / 1024 / 1024).toFixed(2) + " MB";
    const reportLines = [
      "GitHub push report",
      "Workspace: " + root,
      "Repository: " + owner + "/" + repo,
      "Branch: " + targetBranch,
      "Mode: " + (cleanMode ? "clean mirror (all old repo files removed)" : "incremental"),
      "Generated: " + new Date().toISOString(),
      "",
      "Pushed: " + pushedPaths.length + " file(s), " + formatMb(pushedBytes),
      "Unchanged: " + unchanged.length + " file(s)",
      "Removed from GitHub: " + deleted.length + " file(s)",
      "",
      "NOT PUSHED (" + notPushed.length + ")",
      "----------------------------------------",
    ];
    if (!notPushed.length) {
      reportLines.push("None - every eligible file under the limits was pushed.");
    } else {
      for (const item of notPushed) {
        reportLines.push("- " + item.path + " | " + formatMb(item.bytes) + " | " + item.reason);
      }
    }
    if (ignoredRuleNames.size) {
      reportLines.push("", "SKIPPED BY SYNC RULES (not attempted)", "----------------------------------------");
      for (const name of [...ignoredRuleNames].sort()) reportLines.push("- " + name);
    }
    if (state.truncated) {
      reportLines.push("", "NOTE: GitHub returned a truncated remote tree, so the removed-file count may be incomplete.");
    }
    if (filesTruncated) {
      reportLines.push("", "NOTE: The workspace has " + allowed.length + " eligible files, above the " + MAX_SYNC_FILES + " cap.");
    }
    const manifestPath = path.join(root, "github_notpushed.txt");
    let manifestWritten = false;
    try {
      await fs.writeFile(manifestPath, reportLines.join("\n") + "\n", "utf8");
      manifestWritten = true;
    } catch (error) {
      log("warning", "github", "could not write push report", { path: manifestPath, message: error.message });
    }

    // 5. Include the fresh report in the same commit, then commit everything.
    if (manifestWritten) {
      const reportBuffer = Buffer.from(reportLines.join("\n") + "\n", "utf8");
      const reportSha = githubBlobSha(reportBuffer);
      const remoteReportSha = state.remote.get(REPORT_FILE);
      if (remoteReportSha !== reportSha) {
        try {
          const uploadedReportSha = await githubCreateBlob(owner, repo, reportBuffer, false);
          entries.push({ path: REPORT_FILE, mode: "100644", type: "blob", sha: uploadedReportSha });
          pushedPaths.push(REPORT_FILE);
          pushedSet.add(REPORT_FILE);
          pushedBytes += reportBuffer.length;
        } catch (error) {
          failed.push({ path: REPORT_FILE, bytes: reportBuffer.length, reason: error.message });
        }
      } else if (cleanMode && remoteReportSha) {
        entries.push({ path: REPORT_FILE, mode: "100644", type: "blob", sha: remoteReportSha });
      }
    }

    // 6. One tree, one commit, one ref update.
    let commit = { commitSha: state.headSha, commitUrl: "", skipped: true };
    if (entries.length || !state.headSha) {
      commit = await githubCommitTree(
        owner,
        repo,
        targetBranch,
        message + (entries.length ? " (" + entries.length + " changes)" : ""),
        entries,
        state,
        { clean: cleanMode },
      );
    }

    // 7. Fresh repo size so the studio stops showing "size unknown". GitHub's
    // `size` is in KB and can lag right after a push, so fall back to the bytes
    // we actually tracked in this workspace.
    let repoSizeKb = null;
    try {
      const info = await githubApi(githubRepoApi(owner, repo));
      repoSizeKb = Number(info.data?.size || 0);
    } catch {}
    let repoSizeEstimated = !(repoSizeKb > 0);
    if (repoSizeEstimated) {
      repoSizeKb = Math.max(0, Math.ceil(selected.reduce((sum, item) => sum + item.bytes, 0) / 1024));
      repoSizeEstimated = repoSizeKb > 0;
    }

    log("info", "github", "project sync complete", {
      owner,
      repo,
      branch: targetBranch,
      workspace: root,
      clean: cleanMode,
      pushed: pushedPaths.length,
      failed: failed.length,
      unchanged: unchanged.length,
      deleted: deleted.length,
      notPushed: notPushed.length,
      bytes: pushedBytes,
      commit: commit.commitSha,
      filesTruncated,
      remoteTreeTruncated: state.truncated,
      manifestWritten,
    });

    res.json({
      ok: true,
      clean: cleanMode,
      workspace: root,
      branch: targetBranch,
      commit: commit.commitSha,
      commitUrl: commit.commitUrl,
      pushed: pushedPaths,
      failed,
      unchanged,
      deleted,
      notPushed: notPushed.slice(0, 200),
      notPushedTotal: notPushed.length,
      notPushedFile: manifestWritten ? "github_notpushed.txt" : "",
      pushedBytes,
      totalFiles: allowed.length,
      totalBytes,
      truncated: filesTruncated,
      maxFiles: MAX_SYNC_FILES,
      repoSizeKb,
      repoSizeEstimated,
      remoteTreeTruncated: state.truncated,
      deleteSkipped: !cleanMode && Boolean(deleteMissing) && !canDelete,
      skippedLarge: largeFiles,
      skippedIgnored,
    });
  } catch (error) {
    log("error", "github", "project sync failed", { message: error.message });
    const settings = await getSettings().catch(() => null);
    const hint = settings
      ? githubWriteHint(error, settings, req.body?.owner && req.body?.repo ? req.body.owner + "/" + req.body.repo : "")
      : "";
    res.status(502).json({ error: hint ? error.message + " - " + hint : error.message });
  }
});

app.post("/api/github/issues", async (req, res) => {
  try {
    const { owner, repo, title, body = "" } = req.body || {};
    if (!owner || !repo || !title) return res.status(400).json({ error: "owner, repo and title are required." });
    const { data } = await githubApi(githubRepoApi(owner, repo, "/issues"), {
      method: "POST",
      body: { title: String(title), body: String(body || "") },
    });
    res.json({ ok: true, issue: { number: data.number, html_url: data.html_url, title: data.title } });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/github/pulls", async (req, res) => {
  try {
    const { owner, repo, title, head, base, body = "" } = req.body || {};
    if (!owner || !repo || !title || !head || !base) {
      return res.status(400).json({ error: "owner, repo, title, head and base are required." });
    }
    const { data } = await githubApi(githubRepoApi(owner, repo, "/pulls"), {
      method: "POST",
      body: { title: String(title), head: String(head), base: String(base), body: String(body || "") },
    });
    res.json({ ok: true, pull: { number: data.number, html_url: data.html_url, title: data.title } });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* API: OpenCode                                                       */
/* ------------------------------------------------------------------ */

app.post("/api/opencode/connect", async (req, res) => {
  const { projectId, workspace, force } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  try {
    await loadProjectById(projectId);
    const state = await startOpenCode(projectId, workspace || "prop", Boolean(force));
    const payload = await ocFetch(state, "/config/providers").catch(() => null);
    const providers = payload ? await normalizeProviders(payload) : [];
    const settings = await getSettings();
    res.json({
      ok: true,
      baseUrl: state.baseUrl,
      version: state.version,
      providers,
      settingsModel: settings.opencode.model,
      logs: state.logs.slice(-30),
    });
  } catch (error) {
    res.status(502).json({
      error: error.message,
      logs: ocServers.get(projectId)?.logs?.slice(-40) || [],
    });
  }
});

app.post("/api/opencode/global/connect", async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const state = await startOpenCode("__global__", "prop", force);
    const payload = await ocFetch(state, "/config/providers").catch(() => null);
    const providers = payload ? await normalizeProviders(payload) : [];
    const settings = await getSettings();
    res.json({
      ok: true,
      baseUrl: state.baseUrl,
      version: state.version,
      providers,
      settingsModel: settings.opencode.model,
      logs: state.logs.slice(-30),
    });
  } catch (error) {
    res.status(502).json({ error: error.message, logs: ocServers.get("__global__")?.logs?.slice(-40) || [] });
  }
});

app.get("/api/opencode/status", async (req, res) => {
  const out = {};
  for (const [id, state] of ocServers) {
    out[id] = {
      port: state.port,
      baseUrl: state.baseUrl,
      alive: !state.proc.killed,
      version: state.version || null,
      startedAt: state.startedAt,
      logs: state.logs.slice(-40),
      events: state.events.slice(-60),
    };
  }
  res.json({ servers: out });
});

app.post("/api/opencode/disconnect", async (req, res) => {
  const { projectId } = req.body || {};
  const state = ocServers.get(projectId);
  if (state) {
    state.stopped = true;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    try {
      state.sseAbort?.abort();
    } catch {}
    killProcessTree(state.proc);
    ocServers.delete(projectId);
  }
  res.json({ ok: true });
});

app.post("/api/opencode/session", async (req, res) => {
  try {
    const { projectId, title } = req.body || {};
    const state = ocServers.get(projectId);
    if (!state) return res.status(400).json({ error: "OpenCode is not connected for this project" });
    const session = await ocFetch(state, "/session", {
      method: "POST",
      body: JSON.stringify({ title: title || "TwiX session" }),
    });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/opencode/session/:projectId/:sessionId", async (req, res) => {
  try {
    const state = ocServers.get(req.params.projectId);
    if (!state) return res.status(400).json({ error: "OpenCode is not connected" });
    const data = await ocFetch(state, `/session/${req.params.sessionId}/message?limit=200`);
    res.json({ messages: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/opencode/prompt", async (req, res) => {
  try {
    const {
      projectId,
      sessionId,
      text,
      model,
      workspace = "prop",
      context = "",
      attachments = [],
      agent = "twix",
    } = req.body || {};
    const state = ocServers.get(projectId);
    if (!state) return res.status(400).json({ error: "OpenCode is not connected for this project" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Prompt is empty" });

    let sid = sessionId;
    if (!sid) {
      const session = await ocFetch(state, "/session", {
        method: "POST",
        body: JSON.stringify({ title: `TwiX · ${workspace}` }),
      });
      sid = session.id;
    }

    const system = [
      "You are operating the live TwiX 3D scene. Use twix_* tools to inspect and change the scene.",
      `Active studio: ${workspace}. Project units: ${context.units || "m"}.`,
      context.selection?.length ? `Current selection: ${context.selection.join(", ")}.` : "Nothing is selected.",
      context.sceneSummary ? `Scene summary:\n${context.sceneSummary}` : "",
      Array.isArray(context.references) && context.references.length
        ? "Reference sources (use reference_list/reference_read as needed; never modify source files):\n" +
          context.references.slice(0, 30).map((ref) => `- ${ref.label}${ref.url ? " ? " + ref.url : ""}${ref.path ? " ? " + ref.path : ""} (${ref.scope || "project"}${ref.type ? ", " + ref.type : ""})`).join("\n")
        : "",
      await githubContextFor(text),
      await referenceContextFor(text),
      await sessionContextFor(state, text),
      context.approvalMode === "always"
        ? "Call TwiX tools normally. The app asks the user to approve every mutating action before it executes; do not stop and wait for approval in text."
        : context.approvalMode === "plan"
          ? "Present a brief plan before mutating work, then proceed with the tools. The app confirms destructive actions."
          : "Proceed autonomously with the tools; the app confirms destructive actions.",
    ]
      .filter(Boolean)
      .join("\n");

    const parts = [{ type: "text", text: String(text) }];
    if (Array.isArray(attachments) && attachments.length) {
      const entry = await loadProjectById(projectId);
      for (const attachment of attachments.slice(0, 8)) {
        try {
          const scope = attachment.scope === "global" ? "global" : "project";
          const root = scope === "global" ? globalReferencesDir() : path.join(entry.path, "references");
          const target = path.resolve(root, String(attachment.path || ""));
          if (!isInside(root, target) || !fssync.existsSync(target)) continue;
          const ext = path.extname(target).toLowerCase();
          const mime =
            ext === ".png" ? "image/png" :
            ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
            ext === ".webp" ? "image/webp" :
            ext === ".gif" ? "image/gif" :
            ext === ".svg" ? "image/svg+xml" :
            "application/octet-stream";
          if (!mime.startsWith("image/")) continue;
          const data = await fs.readFile(target);
          parts.push({
            type: "file",
            mime,
            filename: attachment.name || path.basename(target),
            url: `data:${mime};base64,${data.toString("base64")}`,
          });
        } catch {}
      }
    }
    await ocFetch(state, `/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model,
        agent,
        system,
        parts,
      }),
    });
    res.json({ ok: true, sessionId: sid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/opencode/abort", async (req, res) => {
  try {
    const { projectId, sessionId } = req.body || {};
    const state = ocServers.get(projectId);
    if (!state) return res.status(400).json({ error: "OpenCode is not connected" });
    await ocFetch(state, `/session/${sessionId}/abort`, { method: "POST" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/opencode/permission", async (req, res) => {
  try {
    const { projectId, sessionId, permissionId, response, remember } = req.body || {};
    const state = ocServers.get(projectId);
    if (!state) return res.status(400).json({ error: "OpenCode is not connected" });
    await ocFetch(state, `/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response, remember: Boolean(remember) }),
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* MCP bridge                                                          */
/* ------------------------------------------------------------------ */

app.post("/api/bridge/tool", async (req, res) => {
  const started = Date.now();
  const { token, projectId, name, args } = req.body || {};
  log("info", "bridge", "tool.call " + name, { projectId, args });
  if (token !== BRIDGE_TOKEN) return res.status(403).json({ error: "Bad bridge token" });
  const set = clients.get(projectId);
  const ws = set ? [...set].find((c) => c.readyState === 1) : null;
  if (!ws) {
    return res.status(409).json({
      ok: false,
      error: "TwiX workspace is not connected. Open the project in the TwiX app and try again.",
    });
  }
  const id = randomUUID();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTools.delete(id);
      resolve({ ok: false, error: "Tool call timed out after 5 minutes" });
    }, 300000);
    pendingTools.set(id, { resolve, timer, projectId, ws });
    ws.send(JSON.stringify({ type: "tool.call", id, name, args: args || {}, projectId }));
  });
  log(result?.ok === false ? "warning" : "info", "bridge", "tool.result " + name, { projectId, ms: Date.now() - started, result });
  res.json(result);
});

app.get("/api/bridge/ping", (req, res) => res.json({ ok: true, clients: [...clients.entries()].map(([k, v]) => [k, v.size]) }));

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "hello") {
      log("info", "ws", "client.hello", { projectId: msg.projectId });
      ws.projectId = msg.projectId;
      if (!clients.has(msg.projectId)) clients.set(msg.projectId, new Set());
      clients.get(msg.projectId).add(ws);
      ws.send(JSON.stringify({ type: "hello.ack", projectId: msg.projectId, bridge: true }));
      return;
    }
    if (msg.type === "tool.result") {
      log(msg.result?.ok === false ? "warning" : "info", "ws", "tool.result", { projectId: ws.projectId, id: msg.id, result: msg.result });
      const pending = pendingTools.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingTools.delete(msg.id);
      pending.resolve(msg.result || { ok: false, error: "Empty tool result" });
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });
  ws.on("close", () => {
    if (!ws.projectId) return;
    const set = clients.get(ws.projectId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) clients.delete(ws.projectId);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25000).unref();

app.use((error, req, res, next) => {
  console.error("[TwiX] request error", req.method, req.path, error?.stack || error);
  log("error", "http", "request error " + req.method + " " + req.path, { message: error?.message, stack: error?.stack });
  if (res.headersSent) return next(error);
  res.status(500).json({ error: error?.message || "Internal server error" });
});

/* ------------------------------------------------------------------ */
/* static + boot                                                       */
/* ------------------------------------------------------------------ */

if (SERVE_DIST && fssync.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

await ensureDir(DATA_DIR);
await ensureDir(LOG_DIR);
await migrateLegacyData();
await migrateGitHubToken();
await pruneLogs();
await ensureDir(globalReferencesDir());
await ensureDir(await normalizeProjectDir());
await ensureExampleMod();

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`AI Creator Studio server ready on ${url}`);
  log("info", "server", "ready", { url, dataDir: DATA_DIR, mcp: MCP_SERVER });
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`MCP bridge: ${MCP_SERVER}`);
  if (!SERVE_DIST) console.log(`Open the Vite dev server (usually http://localhost:5173)`);
});

function shutdown() {
  log("info", "server", "shutdown requested");
  for (const [, state] of ocServers) {
    try {
      state.sseAbort?.abort();
    } catch {}
    killProcessTree(state.proc);
  }
  for (const [, state] of codingServers) {
    try {
      state.sseAbort?.abort();
    } catch {}
    killProcessTree(state.proc);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
