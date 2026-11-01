/*
 * Data portability for AI Creator Studio.
 *
 * - Export every user preference + project + reference into one bundle.
 * - Import that bundle into any other install.
 * - Merge references (and optionally whole projects) straight out of another
 *   install's data folder, e.g. a cloned "… - Copy" build that never had an
 *   exporter.
 *
 * This module only receives the pieces it needs from server/index.mjs so the
 * main server file stays readable.
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const APP_DATA_KIND = "3d-creator-studio-app-data";
const APP_DATA_VERSION = 1;
const MAX_SCENE_BYTES = 220 * 1024 * 1024;

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Blank out anything that should not travel with a shared bundle. */
function redactSettings(settings) {
  const copy = clone(settings) || {};
  if (copy.providers) {
    for (const provider of Object.keys(copy.providers)) {
      if (copy.providers[provider] && "apiKey" in copy.providers[provider]) copy.providers[provider].apiKey = "";
    }
  }
  if (copy.github && "token" in copy.github) copy.github.token = "";
  return copy;
}

function dataDirCandidates(root) {
  return [
    root,
    path.join(root, "data"),
    path.join(root, ".twix3d"),
    path.join(root, "resources", "data"),
    path.join(root, "userData", "data"),
  ];
}

/** Accept a data dir, an install root, or a path to settings.json. */
async function resolveSourceDataDir(raw) {
  let target = path.resolve(String(raw || "").trim().replace(/^["']|["']$/g, ""));
  if (!target) throw new Error("Choose the other install's folder first.");
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`Folder not found: ${target}`);
  if (stat.isFile()) target = path.dirname(target);
  for (const candidate of dataDirCandidates(target)) {
    const hasSettings = fssync.existsSync(path.join(candidate, "settings.json"));
    const hasIndex = fssync.existsSync(path.join(candidate, "reference-index.json"));
    const hasProjects = fssync.existsSync(path.join(candidate, "projects.json"));
    if (hasSettings || hasIndex || hasProjects) return candidate;
  }
  throw new Error(
    "No AI Creator Studio data found there. Point at the other install's folder, its \"data\" folder, or its settings.json.",
  );
}

async function copyDirFiles(from, to, limitFiles = 4000) {
  let copied = 0;
  if (!fssync.existsSync(from)) return copied;
  await fs.mkdir(to, { recursive: true });
  const names = await fs.readdir(from).catch(() => []);
  for (const name of names) {
    if (copied >= limitFiles) break;
    const source = path.join(from, name);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    const dest = path.join(to, name);
    const existing = fssync.existsSync(dest);
    if (existing) {
      const [a, b] = await Promise.all([fs.readFile(source).catch(() => null), fs.readFile(dest).catch(() => null)]);
      if (a && b && a.equals(b)) continue;
      const ext = path.extname(name);
      let n = 2;
      let candidate = path.join(to, `${path.basename(name, ext)} ${n}${ext}`);
      while (fssync.existsSync(candidate)) candidate = path.join(to, `${path.basename(name, ext)} ${++n}${ext}`);
      await fs.copyFile(source, candidate);
      copied++;
      continue;
    }
    await fs.copyFile(source, dest);
    copied++;
  }
  return copied;
}

function uniqueEntryKey(entry) {
  return String(entry?.id || entry?.url || entry?.path || "").trim().toLowerCase();
}

function mergeIndexEntries(current, incoming) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...(incoming || []), ...(current || [])]) {
    if (!entry) continue;
    const key = uniqueEntryKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/** Look for other installs' data folders so the user can just pick one. */
async function scanInstallCandidates(currentDataDir) {
  const roots = [
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), "AppData", "Roaming"),
    path.join(os.homedir(), "AppData", "Local"),
    os.homedir(),
  ].filter(Boolean);
  const seen = new Set();
  const found = [];
  const addCandidate = async (base) => {
    for (const candidate of dataDirCandidates(base)) {
      const key = path.resolve(candidate).toLowerCase();
      if (seen.has(key)) continue;
      const hasSettings = fssync.existsSync(path.join(candidate, "settings.json"));
      const hasIndex = fssync.existsSync(path.join(candidate, "reference-index.json"));
      const hasProjects = fssync.existsSync(path.join(candidate, "projects.json"));
      if (!hasSettings && !hasIndex && !hasProjects) continue;
      seen.add(key);
      const settings = await readJson(path.join(candidate, "settings.json"), null);
      const index = await readJson(path.join(candidate, "reference-index.json"), null);
      found.push({
        dir: candidate,
        folders: settings?.references?.folders?.length || 0,
        links: settings?.references?.links?.length || 0,
        indexEntries: index?.entries?.length || 0,
        updatedAt: index?.updatedAt || null,
        current: path.resolve(candidate).toLowerCase() === path.resolve(currentDataDir).toLowerCase(),
      });
    }
  };

  for (const root of roots) {
    if (!root) continue;
    // ~/.twix3d style folders
    for (const name of ["twix3d", ".twix3d"]) {
      if (fssync.existsSync(path.join(root, name))) await addCandidate(path.join(root, name));
    }
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/twilight|twix|creator ?studio/i.test(entry.name)) continue;
      await addCandidate(path.join(root, entry.name));
    }
  }
  return found;
}

export function registerDataPortability(app, deps) {
  const {
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
  } = deps;

  const settingsPath = () => path.join(DATA_DIR, "settings.json");
  const indexPath = () => path.join(DATA_DIR, "reference-index.json");
  const notesPath = () => path.join(DATA_DIR, "reference-index.md");

  async function collectProjects(includeFiles) {
    const index = await readProjectIndex();
    const projects = [];
    for (const entry of index.projects || []) {
      const meta = await readJson(projectMetaPath(entry.path), null);
      if (!meta) continue;
      const item = {
        id: entry.id,
        name: meta.name || entry.name || "Project",
        workspace: meta.workspace || entry.workspace || "prop",
        meta,
        path: entry.path,
      };
      if (includeFiles) {
        const scenePath = projectScenePath(entry.path);
        const stat = await fs.stat(scenePath).catch(() => null);
        if (stat && stat.size <= MAX_SCENE_BYTES) {
          item.scene = { base64: (await fs.readFile(scenePath)).toString("base64"), bytes: stat.size };
        }
        item.referenceFiles = await encodeFolder(path.join(entry.path, "references"));
      }
      projects.push(item);
    }
    return projects;
  }

  async function encodeFolder(dir, limitFiles = 400, limitBytes = 120 * 1024 * 1024) {
    const out = [];
    let total = 0;
    if (!fssync.existsSync(dir)) return out;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (out.length >= limitFiles) break;
      const target = path.join(dir, name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isFile()) continue;
      total += stat.size;
      if (total > limitBytes) break;
      out.push({ name, base64: (await fs.readFile(target)).toString("base64") });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* info                                                             */
  /* ---------------------------------------------------------------- */

  app.get("/api/app-data/info", async (_req, res) => {
    try {
      const settings = await getSettings();
      const index = await loadReferenceIndex();
      const projects = await readProjectIndex();
      const referenceFiles = fssync.existsSync(globalReferencesDir())
        ? (await fs.readdir(globalReferencesDir())).length
        : 0;
      res.json({
        ok: true,
        appRoot: APP_ROOT,
        dataDir: DATA_DIR,
        settingsPath: settingsPath(),
        version: APP_VERSION,
        references: {
          folders: settings.references?.folders?.length || 0,
          links: settings.references?.links?.length || 0,
          indexEntries: index.entries?.length || 0,
          uploadedFiles: referenceFiles,
        },
        projects: projects.projects?.length || 0,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/app-data/installs", async (_req, res) => {
    try {
      res.json({ ok: true, current: DATA_DIR, installs: await scanInstallCandidates(DATA_DIR) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ---------------------------------------------------------------- */
  /* export                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/api/app-data/export", async (req, res) => {
    try {
      const includeSecrets = req.query.includeSecrets === "1";
      const includeProjects = req.query.includeProjects !== "0";
      const includeReferenceFiles = req.query.includeReferenceFiles === "1";
      const settings = await getSettings();
      const index = await loadReferenceIndex();

      const bundle = {
        kind: APP_DATA_KIND,
        version: APP_DATA_VERSION,
        exportedAt: new Date().toISOString(),
        app: "AI Creator Studio by Twilight Studio",
        appVersion: APP_VERSION,
        secretsIncluded: includeSecrets,
        settings: includeSecrets ? clone(settings) : redactSettings(settings),
        references: {
          folders: settings.references?.folders || [],
          links: settings.references?.links || [],
          index: { updatedAt: index.updatedAt || null, entries: index.entries || [] },
        },
        projects: includeProjects ? await collectProjects(true) : [],
      };
      if (includeReferenceFiles) {
        bundle.references.files = await encodeFolder(globalReferencesDir());
      }

      const fileName = `3d-creator-studio-appdata-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(JSON.stringify(bundle));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ---------------------------------------------------------------- */
  /* import                                                           */
  /* ---------------------------------------------------------------- */

  async function importProject(item, defaultDir, replace) {
    if (!item?.meta) return null;
    const index = await readProjectIndex();
    const existing = (index.projects || []).find(
      (entry) => entry.id === item.id || (entry.name === item.name && entry.workspace === item.workspace),
    );
    let dir;
    let entry;
    if (existing && !replace) {
      return { skipped: true, name: existing.name };
    }
    if (existing) {
      dir = existing.path;
      entry = existing;
    } else {
      const folderName = String(item.name || "Imported project").replace(/[<>:"/\\|?*]/g, "-").trim() || "Imported project";
      let candidate = path.join(defaultDir, folderName);
      let n = 2;
      while (fssync.existsSync(candidate)) candidate = path.join(defaultDir, `${folderName} ${n++}`);
      dir = candidate;
      entry = {
        id: `prj_${randomUUID().slice(0, 8)}`,
        name: item.name || folderName,
        path: dir,
        workspace: item.workspace || "prop",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        temporary: false,
      };
    }
    await ensureDir(dir);
    const meta = clone(item.meta);
    meta.id = entry.id;
    meta.path = undefined;
    await writeJsonAtomic(projectMetaPath(dir), meta);
    if (item.scene?.base64) {
      await fs.writeFile(projectScenePath(dir), Buffer.from(item.scene.base64, "base64"));
    }
    for (const file of item.referenceFiles || []) {
      await writeReferenceBundleFile(path.join(dir, "references"), file.name, file.base64);
    }
    if (!existing) {
      const next = await readProjectIndex();
      next.projects = [entry, ...(next.projects || [])];
      await writeProjectIndex(next);
    }
    return { created: !existing, name: entry.name, path: dir };
  }

  app.post("/api/app-data/import", async (req, res) => {
    try {
      const body = req.body || {};
      const bundle = body.bundle && typeof body.bundle === "object" ? body.bundle : body;
      if (!bundle || bundle.kind !== APP_DATA_KIND) {
        return res.status(400).json({ error: "That file is not an AI Creator Studio app-data bundle." });
      }
      const mode = body.mode === "replace" ? "replace" : "merge";
      const current = await getSettings();
      const incoming = bundle.settings || {};

      const merged = clone(current);
      for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        if (key === "providers") continue;
        if (key === "github") continue;
        if (key === "references") continue;
        if (mode === "replace" || merged[key] === undefined) merged[key] = value;
      }
      merged.providers = {
        openai: { ...(merged.providers?.openai || {}), ...(incoming.providers?.openai || {}) },
        gemini: { ...(merged.providers?.gemini || {}), ...(incoming.providers?.gemini || {}) },
      };
      for (const provider of Object.keys(merged.providers)) {
        if (!merged.providers[provider].apiKey && current.providers?.[provider]?.apiKey) {
          merged.providers[provider].apiKey = current.providers[provider].apiKey;
        }
      }
      merged.github = { ...(merged.github || {}), ...(incoming.github || {}) };
      if (!merged.github.token && current.github?.token) merged.github.token = current.github.token;

      const linkResult = mergeReferenceList(
        "link",
        current.references?.links || [],
        bundle.references?.links || incoming.references?.links || [],
        mode === "replace",
      );
      const folderResult = mergeReferenceList(
        "folder",
        current.references?.folders || [],
        bundle.references?.folders || incoming.references?.folders || [],
        mode === "replace",
      );
      merged.references = { links: linkResult.list, folders: folderResult.list };
      await saveSettings(merged);

      const currentIndex = await loadReferenceIndex();
      const mergedEntries = mergeIndexEntries(currentIndex.entries, bundle.references?.index?.entries);
      if (mergedEntries.length !== (currentIndex.entries || []).length) {
        await writeJsonAtomic(indexPath(), { updatedAt: new Date().toISOString(), entries: mergedEntries });
      }

      let files = 0;
      for (const file of bundle.references?.files || []) {
        await writeReferenceBundleFile(globalReferencesDir(), file.name, file.base64);
        files++;
      }

      const defaultDir = (await getSettings()).defaultProjectDir;
      const projectResults = [];
      for (const project of bundle.projects || []) {
        const result = await importProject(project, defaultDir, mode === "replace");
        if (result) projectResults.push(result);
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
          indexEntries: Math.max(0, mergedEntries.length - (currentIndex.entries || []).length),
          referenceFiles: files,
          projects: projectResults.filter((item) => item.created).length,
        },
        projects: projectResults,
        missingFolders,
        secretsImported: Boolean(bundle.secretsIncluded),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ---------------------------------------------------------------- */
  /* merge straight from another install                              */
  /* ---------------------------------------------------------------- */

  app.post("/api/app-data/merge-install", async (req, res) => {
    try {
      const body = req.body || {};
      const sourceDir = await resolveSourceDataDir(body.sourceDir);
      const includeReferenceFiles = body.includeReferenceFiles !== false;
      const includeProjects = body.includeProjects === true;
      const rescan = body.rescan === true;

      const sourceSettings = await readJson(path.join(sourceDir, "settings.json"), null);
      if (!sourceSettings && !fssync.existsSync(path.join(sourceDir, "reference-index.json"))) {
        return res.status(400).json({
          error: `Nothing to import from ${sourceDir}. Expected settings.json or reference-index.json.`,
        });
      }

      const current = await getSettings();
      const linkResult = mergeReferenceList(
        "link",
        current.references?.links || [],
        sourceSettings?.references?.links || [],
        false,
      );
      const folderResult = mergeReferenceList(
        "folder",
        current.references?.folders || [],
        sourceSettings?.references?.folders || [],
        false,
      );
      await saveSettings({ references: { links: linkResult.list, folders: folderResult.list } });

      const sourceIndex = await readJson(path.join(sourceDir, "reference-index.json"), { entries: [] });
      const currentIndex = await loadReferenceIndex();
      const mergedEntries = mergeIndexEntries(currentIndex.entries, sourceIndex?.entries);
      await writeJsonAtomic(indexPath(), { updatedAt: new Date().toISOString(), entries: mergedEntries });

      let files = 0;
      if (includeReferenceFiles) {
        files = await copyDirFiles(path.join(sourceDir, "references"), globalReferencesDir());
      }

      const projectResults = [];
      if (includeProjects) {
        const sourceProjects = await readJson(path.join(sourceDir, "projects.json"), { projects: [] });
        const defaultDir = (await getSettings()).defaultProjectDir;
        for (const entry of sourceProjects.projects || []) {
          const meta = await readJson(projectMetaPath(entry.path), null);
          if (!meta) continue;
          const scenePath = projectScenePath(entry.path);
          const stat = await fs.stat(scenePath).catch(() => null);
          const item = {
            id: entry.id,
            name: meta.name || entry.name,
            workspace: meta.workspace || entry.workspace,
            meta,
            scene: stat ? { base64: (await fs.readFile(scenePath)).toString("base64") } : null,
            referenceFiles: await encodeFolder(path.join(entry.path, "references")),
          };
          const result = await importProject(item, defaultDir, false);
          if (result) projectResults.push(result);
        }
      }

      let rescanned = 0;
      if (rescan) {
        const index = await scanReferenceSources();
        rescanned = index.entries?.length || 0;
      }

      const missingFolders = (folderResult.list || [])
        .filter((folder) => !fssync.existsSync(folder.path))
        .map((folder) => folder.path);

      res.json({
        ok: true,
        sourceDir,
        added: {
          links: linkResult.added,
          folders: folderResult.added,
          indexEntries: Math.max(0, mergedEntries.length - (currentIndex.entries || []).length),
          referenceFiles: files,
          projects: projectResults.filter((item) => item.created).length,
        },
        total: {
          links: linkResult.list.length,
          folders: folderResult.list.length,
          indexEntries: mergedEntries.length,
        },
        projects: projectResults,
        missingFolders,
        rescanned,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
