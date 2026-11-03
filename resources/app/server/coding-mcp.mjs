#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { codingTools } from "../shared/coding-tools.mjs";
import { assessCommand } from "../shared/command-safety.mjs";

const ROOT = path.resolve(process.env.TWIX_CODING_ROOT || process.cwd());
const APP_ROOT = process.env.TWIX_APP_ROOT ? path.resolve(process.env.TWIX_APP_ROOT) : "";
const TRUSTED = process.env.TWIX_CODING_TRUSTED === "1";
const UNITY_PORT = process.env.TWIX_UNITY_BRIDGE_PORT ? Number(process.env.TWIX_UNITY_BRIDGE_PORT) : null;
const BRIDGE_URL = process.env.TWIX_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.TWIX_BRIDGE_TOKEN || "";
const IGNORED = new Set(["node_modules", ".git", ".svn", "dist", "build", ".next", ".turbo", "release", ".twix"]);
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const GITHUB_ONLY = process.env.TWIX_GITHUB_ONLY === "1";
// The app writes a research gate after every coding prompt, once GitHub and the
// indexed local references have been searched. Mutating tools refuse to run
// without a fresh gate, which guarantees research happened before any edit.
const RESEARCH_GATE_FILE = process.env.TWIX_RESEARCH_GATE_FILE || "";
const CODING_PROJECT_ID = process.env.TWIX_CODING_PROJECT_ID || "";
const RESEARCH_GATE_TTL = 60 * 60 * 1000;

const CREATOR_STUDIO_GUIDE = [
  "## Creator Studio 3D framework",
  "Creator Studio is a live Three.js modelling workspace. The coding and Unity assistants can drive it through creator_scene_tool.",
  "",
  "Professional modelling rules:",
  "- For Tripo/Meshy-class results use ai_model_generate (it calls the configured Meshy or Tripo key and imports a textured GLB). Use humanoid_create for offline procedural characters. Characters must be ONE continuous, UV-mapped, lofted mesh with a real skeleton. Use humanoid_create (height, build, feminine, muscle, age, pose, hairStyle, skinColor, faceDetail, rig). Body and face share one skinned mesh; hair is a separate skinned mesh. Never stack cubes/capsules for a human.",
  "- Curved, organic and manufactured props use prop_create presets (vase, bottle, lamp, barrel, bowl, crate, pillar, table, chair, sword, axe, shield, rock) or mesh_create (loft sections, revolve profile, tube sweep).",
  "- object_create primitives are blockout-only. Join blockouts with object_join before calling an asset finished.",
  "- Finish with mesh_set_smooth, mesh_generate_uv, materials (material_create/material_assign), scene_validate and export_scene.",
  "- After export, creator_3d_export copies the GLB/FBX into this workspace (default Assets/Models). Prefer GLB for rigged or textured assets.",
  "- creator_library_list searches the user's 3D Reference Library (models, rigs, clips, textures with bone/clip/blendshape counts). creator_library_copy copies a chosen library asset into this workspace so it can be used directly. Check the library before building a new character, prop or rig.",
  "",
  "Photo framework: creator_photo_generate uses the Creator Studio image provider and writes the PNG into this workspace. Use it for photos, icons, sprites and textures. For layered editing, point the user to the Photo applet.",
  "",
  "Typical flow: creator_scene_list -> creator_scene_tool(tool='scene_inspect') -> creator_scene_tool(tool='ai_model_generate' for a Tripo/Meshy-class asset, or humanoid_create/mesh_create/prop_create offline) -> material/UV tools -> creator_3d_export(format='glb') -> reference the exported file in the project.",
].join("\n");


function researchGateStatus() {
  if (!RESEARCH_GATE_FILE) return { required: false, ok: true, reason: "" };
  let gate = null;
  try {
    gate = JSON.parse(fssync.readFileSync(RESEARCH_GATE_FILE, "utf8"));
  } catch {
    gate = null;
  }
  if (!gate) {
    return { required: true, ok: false, reason: "no pre-flight research briefing exists for this prompt" };
  }
  const at = new Date(gate.at || 0).getTime();
  if (!Number.isFinite(at) || Date.now() - at > RESEARCH_GATE_TTL) {
    return { required: true, ok: false, reason: "the pre-flight research briefing is stale" };
  }
  return { required: true, ok: true, reason: "", counts: gate.counts || {} };
}

function assertResearchGate(toolName) {
  const status = researchGateStatus();
  if (!status.required || status.ok) return;
  throw new Error(
    "Pre-flight research gate blocked " +
      toolName +
      ": " +
      status.reason +
      ". The Coding editor searches GitHub and the indexed Reference Library before every prompt; send the prompt again so the briefing exists, then retry.",
  );
}

function resolveInRoot(input = ".") {
  const target = path.resolve(ROOT, String(input || "."));
  const rel = path.relative(ROOT, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the coding workspace");
  return target;
}

// When trusted mode is on the user grants full PC access: absolute paths and
// paths outside the selected workspace are allowed for reads, writes and
// commands. Without trust the workspace stays a hard boundary.
function resolvePath(input = ".") {
  const raw = String(input || ".");
  if (!TRUSTED) return resolveInRoot(raw);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
}

function relPath(target) {
  const rel = path.relative(ROOT, target);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  return target.replace(/\\/g, "/");
}

function isInsideRoot(target) {
  const rel = path.relative(ROOT, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsidePath(base, target) {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function activePromptText() {
  if (!RESEARCH_GATE_FILE) return "";
  try {
    const gate = JSON.parse(fssync.readFileSync(RESEARCH_GATE_FILE, "utf8"));
    return String(gate?.prompt || "");
  } catch {
    return "";
  }
}

function promptMentionsApp(prompt) {
  return /(?:ai creator studio|3d creator studio|creator studio|twilight studio 3d|twilight studio)/i.test(
    String(prompt || ""),
  );
}

function assertAppTarget(target, action = "modify") {
  if (!APP_ROOT || !TRUSTED) return;
  if (isInsidePath(ROOT, APP_ROOT)) return;
  if (!isInsidePath(APP_ROOT, target)) return;
  if (promptMentionsApp(activePromptText())) return;
  throw new Error(
    "Creator Studio Safety blocked this " +
      action +
      ": your active workspace is " +
      ROOT +
      ", but the target is inside the Creator Studio app at " +
      APP_ROOT +
      ". Switch the Coding workspace to the app folder first, or ask explicitly for app changes.",
  );
}

const APP_WRITE_INTENT =
  /(?:^|[^<>])>{1,2}(?!\s*&)|\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|set-item|del|erase|rmdir|rd|rm|mkdir|md|npm\s+(?:install|i|ci|run|uninstall)|pnpm|yarn|git\s+(?:commit|push|reset|clean|checkout|restore)|node\s+(?:scripts|[\w.-]+\.mjs)|npx|tsc|vite|electron)\b/i;

function assertAppCommand(command, cwd) {
  if (!APP_ROOT || !TRUSTED) return;
  if (isInsidePath(ROOT, APP_ROOT)) return;
  if (promptMentionsApp(activePromptText())) return;
  if (!APP_WRITE_INTENT.test(String(command || ""))) return;
  const targetsApp =
    (cwd && isInsidePath(APP_ROOT, cwd)) ||
    String(command || "").toLowerCase().includes(APP_ROOT.toLowerCase()) ||
    String(command || "").toLowerCase().includes(APP_ROOT.replace(/\\/g, "/").toLowerCase());
  if (!targetsApp) return;
  throw new Error(
    "Creator Studio Safety blocked this command: your active workspace is " +
      ROOT +
      ", but the command modifies the Creator Studio app at " +
      APP_ROOT +
      ". Switch the Coding workspace to the app folder first, or ask explicitly for app changes.",
  );
}

function assertCommandScope(command) {
  const absolute = command.match(/[A-Za-z]:[\\/][^"'`\s|&;)]*/g) || [];
  for (const candidate of absolute) {
    const target = path.resolve(candidate.replace(/[\\/]+$/, ""));
    if (!isInsideRoot(target)) {
      throw new Error(`Command references a path outside the trusted project: ${candidate}`);
    }
  }
  if (/(?:^|[\s&|;])(?:cd|pushd|set-location)\s+\.\.[\\/]/i.test(command)) {
    throw new Error("Command tries to leave the trusted project with a relative parent path.");
  }
  if (/%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|\$HOME|\$env:USERPROFILE|\$env:APPDATA/i.test(command)) {
    throw new Error("Command references a user-profile path outside the trusted project.");
  }
}

async function listFiles(dir, depth, includeIgnored, level = 0) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!includeIgnored && IGNORED.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    const node = { name: entry.name, path: relPath(target), type: entry.isDirectory() ? "dir" : "file" };
    if (entry.isDirectory()) {
      if (level < depth) node.children = await listFiles(target, depth, includeIgnored, level + 1);
    } else {
      const stat = await fs.stat(target).catch(() => null);
      node.size = stat?.size || 0;
    }
    out.push(node);
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

async function bridgeFetch(pathname, options = {}) {
  if (!BRIDGE_URL) throw new Error("The AI Creator Studio bridge is unavailable. Open the GitHub panel or restart the app.");
  const response = await fetch(BRIDGE_URL + pathname, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 25000),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "HTTP " + response.status }));
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  return payload;
}

const server = new Server(
  { name: "twix-coding", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: codingTools
    .filter((tool) => !GITHUB_ONLY || tool.name.startsWith("github_") || tool.name === "download_url")
    .filter((tool) => !tool.name.startsWith("unity_") || Boolean(UNITY_PORT))
    .filter((tool) => !(UNITY_PORT && tool.name === "run_command"))
    .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const respond = (payload, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  });
  try {
    if (GITHUB_ONLY && !(name.startsWith("github_") || name === "download_url")) {
      return respond({ ok: false, error: "This research workspace only exposes GitHub tools." }, true);
    }
    if (name.startsWith("unity_")) {
      if (!UNITY_PORT) return respond({ ok: false, error: "Unity bridge is not connected for this workspace." }, true);
      if (name === "unity_state") {
        const response = await fetch("http://127.0.0.1:" + UNITY_PORT + "/state", { signal: AbortSignal.timeout(8000) });
        return respond(await response.json(), !response.ok);
      }
      const action = name.replace("unity_", "");
      // JsonUtility is strict about field types; models often send numbers or
      // booleans where the bridge declares strings. Normalise them first.
      const unityArgs = { ...args };
      for (const key of ["path", "parentPath", "name", "primitive", "component", "property", "value", "color", "tag", "layer", "materialPath", "shader", "folder", "filter", "query"]) {
        if (unityArgs[key] !== undefined && unityArgs[key] !== null) unityArgs[key] = String(unityArgs[key]);
      }
      for (const key of ["x", "y", "z", "rx", "ry", "rz", "sx", "sy", "sz", "amount", "index", "limit"]) {
        if (typeof unityArgs[key] === "string" && unityArgs[key].trim() !== "" && Number.isFinite(Number(unityArgs[key]))) unityArgs[key] = Number(unityArgs[key]);
      }
      for (const key of ["active", "enabled", "worldPositionStays"]) {
        if (typeof unityArgs[key] === "string") unityArgs[key] = unityArgs[key].toLowerCase() === "true" || unityArgs[key] === "1";
      }
      const response = await fetch("http://127.0.0.1:" + UNITY_PORT + "/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...unityArgs }),
        signal: AbortSignal.timeout(30000),
      });
      const payload = await response.json().catch(() => ({ ok: response.ok }));
      return respond(payload, !response.ok || payload.ok === false);
    }
    if (name === "creator_studio_guide") {
      return respond({ ok: true, guide: CREATOR_STUDIO_GUIDE });
    }
    if (name === "creator_photo_generate") {
      if (!BRIDGE_URL) return respond({ ok: false, error: "Creator Studio bridge is not configured for this workspace." }, true);
      if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode to save generated images." }, true);
      const prompt = String(args.prompt || "").trim();
      if (!prompt) return respond({ ok: false, error: "prompt is required" }, true);
      const response = await fetch(BRIDGE_URL + "/api/providers/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: args.provider === "gemini" ? "gemini" : "openai",
          prompt,
          size: args.size || "1024x1024",
        }),
        signal: AbortSignal.timeout(190000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.dataUrl) {
        return respond({ ok: false, error: payload.error || "Image generation failed (HTTP " + response.status + ")" }, true);
      }
      let bytes;
      if (String(payload.dataUrl).startsWith("data:")) {
        const base64 = String(payload.dataUrl).split(",")[1] || "";
        bytes = Buffer.from(base64, "base64");
      } else {
        const remote = await fetch(String(payload.dataUrl), { signal: AbortSignal.timeout(60000) });
        if (!remote.ok) return respond({ ok: false, error: "Could not download the generated image" }, true);
        bytes = Buffer.from(await remote.arrayBuffer());
      }
      let destination = args.destination ? String(args.destination) : "Assets/Textures";
      if (!path.extname(destination)) destination = path.join(destination, "CreatorStudio-" + Date.now() + ".png");
      const target = path.isAbsolute(destination) ? destination : path.resolve(ROOT, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return respond({ ok: true, path: relPath(target), bytes: bytes.length, provider: payload.provider || null, model: payload.model || null });
    }
    if (name.startsWith("creator_")) {
      if (!BRIDGE_URL) return respond({ ok: false, error: "Creator Studio bridge is not configured for this workspace." }, true);
      const listScenes = async () => {
        const response = await fetch(BRIDGE_URL + "/api/bridge/scenes", { signal: AbortSignal.timeout(8000) });
        const payload = await response.json().catch(() => ({}));
        return Array.isArray(payload.scenes) ? payload.scenes : [];
      };
      if (name === "creator_library_list") {
        if (!BRIDGE_URL) return respond({ ok: false, error: "Creator Studio bridge is not configured for this workspace." }, true);
        const params = new URLSearchParams({
          kind: args.kind ? String(args.kind) : "models",
          query: args.query ? String(args.query) : "",
          limit: String(Math.max(1, Math.min(120, Number(args.limit) || 40))),
        });
        const response = await fetch(BRIDGE_URL + "/api/bridge/library?" + params.toString(), { signal: AbortSignal.timeout(20000) });
        const payload = await response.json().catch(() => ({ ok: false, error: "Library returned invalid JSON (HTTP " + response.status + ")" }));
        return respond(payload, !response.ok || payload.ok === false);
      }
      if (name === "creator_library_copy") {
        if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode to copy library assets." }, true);
        if (!BRIDGE_URL) return respond({ ok: false, error: "Creator Studio bridge is not configured for this workspace." }, true);
        const libraryResponse = await fetch(BRIDGE_URL + "/api/bridge/library?kind=models&limit=1", { signal: AbortSignal.timeout(20000) });
        const library = await libraryResponse.json().catch(() => ({}));
        const folder = library && library.folder ? String(library.folder) : "";
        if (!folder) return respond({ ok: false, error: "No 3D library folder is linked. Ask the user to link one in the 3D applet." }, true);
        const raw = String(args.path || "");
        if (!raw) return respond({ ok: false, error: "path is required" }, true);
        const root = path.resolve(folder);
        const source = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
        const relative = path.relative(root, source);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return respond({ ok: false, error: "That path is outside the 3D library folder." }, true);
        }
        const stat = await fs.stat(source).catch(() => null);
        if (!stat || !stat.isFile()) return respond({ ok: false, error: "Library file not found" }, true);
        const ext = path.extname(source).slice(1).toLowerCase();
        const image = ["png", "jpg", "jpeg", "webp", "bmp", "tga", "gif", "hdr", "exr", "ktx2", "svg"].includes(ext);
        let destination = args.destination ? String(args.destination) : image ? "Assets/Textures" : "Assets/Models";
        if (!path.extname(destination)) destination = path.join(destination, path.basename(source));
        const target = path.isAbsolute(destination) ? destination : path.resolve(ROOT, destination);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        return respond({
          ok: true,
          path: relPath(target),
          source: source.replace(/\\/g, "/"),
          bytes: stat.size,
          kind: image ? "texture" : ext === "anim" || ext === "bvh" ? "animation" : "model",
        });
      }
      if (name === "creator_scene_list") {
        const scenes = await listScenes();
        return respond({ ok: true, scenes });
      }
      if (name === "creator_scene_tool" || name === "creator_3d_export") {
        let projectId = args.projectId ? String(args.projectId) : "";
        if (!projectId) {
          const scenes = await listScenes();
          projectId = scenes[0] && scenes[0].projectId ? String(scenes[0].projectId) : "";
        }
        if (!projectId) {
          return respond({ ok: false, error: "No Creator Studio 3D workspace is open. Ask the user to open the 3D applet on a project, then retry." }, true);
        }
        const callScene = async (toolName, toolArgs) => {
          const response = await fetch(BRIDGE_URL + "/api/bridge/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: BRIDGE_TOKEN,
              projectId,
              name: toolName,
              args: toolArgs || {},
            }),
            signal: AbortSignal.timeout(310000),
          });
          return response.json().catch(() => ({ ok: false, error: "Bridge returned invalid JSON (HTTP " + response.status + ")" }));
        };
        if (name === "creator_scene_tool") {
          const toolName = String(args.tool || "").replace(/^twix_/, "");
          if (!toolName) return respond({ ok: false, error: "tool is required" }, true);
          const result = await callScene(toolName, args.args || {});
          return respond(result, result && result.ok === false);
        }
        if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode to copy exported models." }, true);
        const format = ["glb", "fbx", "obj", "stl"].includes(String(args.format)) ? String(args.format) : "glb";
        const fileName = args.fileName ? String(args.fileName) : "CreatorStudio-" + Date.now() + "." + format;
        const exported = await callScene("export_scene", {
          format,
          scope: args.scope === "selection" ? "selection" : "scene",
          fileName,
          includeTextures: true,
        });
        if (!exported || exported.ok === false) return respond(exported || { ok: false, error: "Export failed" }, true);
        const sourcePath = exported && exported.data && exported.data.path ? String(exported.data.path) : "";
        if (!sourcePath) return respond({ ok: false, error: "The 3D app did not return an export path." }, true);
        let destination = args.destination ? String(args.destination) : "Assets/Models";
        if (!path.extname(destination)) destination = path.join(destination, path.basename(sourcePath));
        const target = path.isAbsolute(destination) ? destination : path.resolve(ROOT, destination);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(sourcePath, target);
        const stat = await fs.stat(target);
        return respond({
          ok: true,
          projectId,
          path: relPath(target),
          source: sourcePath,
          bytes: stat.size,
          format,
          warnings: exported.warnings || [],
          report: exported.data && exported.data.report ? exported.data.report : null,
        });
      }
      return respond({ ok: false, error: "Unknown Creator Studio tool: " + name }, true);
    }
    if (name === "get_root") {
      return respond({ ok: true, root: ROOT, trusted: TRUSTED });
    }
    if (name === "list_files") {
      const target = resolvePath(args.path || ".");
      const depth = Math.max(0, Math.min(4, Number(args.depth ?? 2)));
      const children = await listFiles(target, depth, Boolean(args.includeIgnored));
      return respond({ ok: true, root: ROOT, path: relPath(target), children });
    }
    if (name === "read_file") {
      const target = resolvePath(args.path);
      const stat = await fs.stat(target);
      if (stat.size > 2 * 1024 * 1024) return respond({ ok: false, error: "File is larger than 2 MB" }, true);
      const content = await fs.readFile(target, "utf8");
      return respond({
        ok: true,
        path: relPath(target),
        content,
        lines: content.split("\n").length,
        bytes: stat.size,
      });
    }
    if (name === "write_file") {
      assertResearchGate(name);
      if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode." }, true);
      const target = resolvePath(args.path);
      assertAppTarget(target, "write " + relPath(target));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const content = String(args.content ?? "");
      await fs.writeFile(target, content, "utf8");
      // Keep the live Unity AssetDatabase in sync with script/asset edits made
      // through the bridge, without requiring Unity to regain OS focus.
      if (UNITY_PORT && /\.(cs|shader|asmdef|asmref|asset|mat|prefab)$/i.test(target)) {
        try {
          await fetch("http://127.0.0.1:" + UNITY_PORT + "/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "refresh" }),
            signal: AbortSignal.timeout(8000),
          });
        } catch {}
      }
      return respond({ ok: true, path: relPath(target), bytes: Buffer.byteLength(content) });
    }
    if (name === "search_files") {
      const query = String(args.query || "");
      if (!query) return respond({ ok: false, error: "query is required" }, true);
      const base = resolvePath(args.path || ".");
      const limit = Math.max(1, Math.min(200, Number(args.limit ?? 60)));
      const matches = [];
      let regex;
      try {
        regex = new RegExp(query, "i");
      } catch {
        regex = null;
      }
      const walk = async (dir) => {
        if (matches.length >= limit) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= limit) return;
          if (IGNORED.has(entry.name)) continue;
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(target);
          } else {
            const stat = await fs.stat(target).catch(() => null);
            if (!stat || stat.size > 512 * 1024) continue;
            const content = await fs.readFile(target, "utf8").catch(() => null);
            if (content === null) continue;
            content.split("\n").forEach((line, index) => {
              if (matches.length >= limit) return;
              if (regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase())) {
                matches.push({ path: relPath(target), line: index + 1, text: line.slice(0, 240) });
              }
            });
          }
        }
      };
      await walk(base);
      return respond({ ok: true, query, matches });
    }
    if (name === "run_command") {
      assertResearchGate(name);
      if (UNITY_PORT) {
        return respond(
          { ok: false, error: "Shell commands are disabled in Unity sessions. Use the unity_* bridge tools for Unity, and the Coding applet for host shell work." },
          true,
        );
      }
      if (!TRUSTED) return respond({ ok: false, error: "Commands are disabled. Enable trusted workspace in Coding mode." }, true);
      const cwd = resolvePath(args.cwd || ".");
      const timeout = Math.max(5000, Math.min(300000, Number(args.timeoutMs ?? 120000)));
      const command = String(args.command || "");
      if (!command.trim()) return respond({ ok: false, error: "command is required" }, true);
      if (!TRUSTED) {
        try {
          assertCommandScope(command);
        } catch (error) {
          return respond({ ok: false, error: error.message }, true);
        }
      }
      try {
        assertAppCommand(command, cwd);
      } catch (error) {
        return respond({ ok: false, blocked: true, denied: true, error: error.message }, true);
      }
      // Creator Studio command safety: classify before anything runs. A
      // dangerous command must be approved in the desktop UI; if the approval
      // bridge is unavailable the command is denied rather than run blind.
      const assessment = assessCommand(command, { cwd, platform: process.platform });
      let approvedDanger = false;
      if (assessment.requiresApproval) {
        if (!BRIDGE_URL) {
          return respond(
            {
              ok: false,
              blocked: true,
              denied: true,
              error:
                "Creator Studio Safety blocked this command because the approval bridge is unavailable. " +
                (assessment.reasons[0] || assessment.summary),
              assessment,
            },
            true,
          );
        }
        let approval;
        try {
          approval = await bridgeFetch("/api/coding/command-approval", {
            method: "POST",
            timeoutMs: 260000,
            body: {
              command,
              cwd,
              projectId: CODING_PROJECT_ID,
              platform: process.platform,
            },
          });
        } catch (error) {
          return respond(
            {
              ok: false,
              blocked: true,
              denied: true,
              error:
                "Creator Studio Safety blocked this command because approval could not be requested (" +
                error.message +
                "). " +
                (assessment.reasons[0] || assessment.summary),
              assessment,
            },
            true,
          );
        }
        if (!approval?.approved) {
          return respond(
            {
              ok: false,
              blocked: true,
              denied: true,
              error:
                "Creator Studio Safety: " +
                (approval?.reason || "the user denied this command.") +
                " Nothing was run. " +
                (approval?.assessment?.summary || assessment.summary),
              assessment: approval?.assessment || assessment,
            },
            true,
          );
        }
        approvedDanger = true;
      }
      const result = await new Promise((resolve) => {
        exec(
          command,
          { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: true },
          (error, stdout, stderr) => {
            resolve({
              code: error?.code ?? 0,
              stdout: String(stdout || "").slice(-20000),
              stderr: String(stderr || "").slice(-20000),
              timedOut: Boolean(error?.killed),
            });
          },
        );
      });
      return respond({
        ok: result.code === 0,
        ...result,
        ...(approvedDanger ? { safety: { approved: true, severity: assessment.severity } } : {}),
      });
    }
    if (name.startsWith("reference_")) {
      if (name === "reference_sources") {
        return respond(await bridgeFetch("/api/references"));
      }
      if (
        name === "reference_search" ||
        name === "reference_search_local" ||
        name === "reference_search_urls" ||
        name === "reference_search_github"
      ) {
        const query = String(args.query || "").trim();
        if (!query) return respond({ ok: false, error: "query is required" }, true);
        const limit = Math.max(1, Math.min(30, Number(args.limit ?? 8)));
        const scope =
          name === "reference_search_local"
            ? "local"
            : name === "reference_search_urls"
              ? "url"
              : name === "reference_search_github"
                ? "github"
                : String(args.scope || "all").toLowerCase();
        const payload = await bridgeFetch(
          `/api/references/search?q=${encodeURIComponent(query)}&limit=${limit}&scope=${encodeURIComponent(scope)}`,
        );
        return respond(payload, false);
      }
      if (name === "reference_status") {
        return respond(await bridgeFetch("/api/references/status"));
      }
      if (name === "reference_index_source") {
        assertResearchGate(name);
        const kind = String(args.kind || "").toLowerCase();
        const id = String(args.id || "").trim();
        if (!["folder", "link"].includes(kind)) {
          return respond({ ok: false, error: "kind must be folder or link" }, true);
        }
        if (!id) return respond({ ok: false, error: "id is required" }, true);
        return respond(
          await bridgeFetch("/api/references/index-source", {
            method: "POST",
            timeoutMs: 180000,
            body: { kind, id },
          }),
        );
      }
      if (name === "reference_read") {
        const params = new URLSearchParams({
          id: String(args.id || ""),
          url: String(args.url || ""),
          path: String(args.path || ""),
          maxChars: String(Math.max(200, Math.min(20000, Number(args.maxChars ?? 8000)))),
        });
        return respond(await bridgeFetch(`/api/references/entry?${params}`));
      }
    }
    if (name.startsWith("github_") || name === "download_url") {
      if (name === "github_status") {
        return respond(await bridgeFetch("/api/github/status"));
      }
      if (name === "github_index_repo") {
        assertResearchGate(name);
        const owner = String(args.owner || "").trim();
        const repo = String(args.repo || "").trim();
        if (!owner || !repo) return respond({ ok: false, error: "owner and repo are required" }, true);
        return respond(
          await bridgeFetch("/api/github/index", {
            method: "POST",
            timeoutMs: 120000,
            body: { owner, repo, force: Boolean(args.force) },
          }),
        );
      }
      if (name === "github_list_repos") {
        const limit = Math.max(1, Math.min(100, Number(args.limit ?? 40)));
        return respond(await bridgeFetch(`/api/github/repos?perPage=${limit}`));
      }
      if (name === "github_search_repositories") {
        const query = String(args.query || "").trim();
        if (!query) return respond({ ok: false, error: "query is required" }, true);
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
        return respond(await bridgeFetch(`/api/github/search?type=repositories&limit=${limit}&q=${encodeURIComponent(query)}`));
      }
      if (name === "github_search_code") {
        const query = String(args.query || "").trim();
        if (!query) return respond({ ok: false, error: "query is required" }, true);
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
        const scoped = args.repo ? ` repo:${String(args.repo).trim()}` : "";
        return respond(
          await bridgeFetch(`/api/github/search?type=code&limit=${limit}&q=${encodeURIComponent(query + scoped)}`),
        );
      }
      if (name === "github_repo_tree") {
        const owner = String(args.owner || "").trim();
        const repo = String(args.repo || "").trim();
        if (!owner || !repo) return respond({ ok: false, error: "owner and repo are required" }, true);
        const params = new URLSearchParams({
          ref: String(args.ref || ""),
          path: String(args.path || ""),
          recursive: args.recursive ? "1" : "0",
        });
        return respond(await bridgeFetch(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree?${params}`));
      }
      if (name === "github_read_file") {
        const owner = String(args.owner || "").trim();
        const repo = String(args.repo || "").trim();
        const filePath = String(args.path || "").trim();
        if (!owner || !repo || !filePath) return respond({ ok: false, error: "owner, repo and path are required" }, true);
        const params = new URLSearchParams({ path: filePath, ref: String(args.ref || "") });
        return respond(await bridgeFetch(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/file?${params}`));
      }
      if (name === "github_download_file") {
        assertResearchGate(name);
        if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode." }, true);
        const owner = String(args.owner || "").trim();
        const repo = String(args.repo || "").trim();
        const filePath = String(args.path || "").trim();
        if (!owner || !repo || !filePath) return respond({ ok: false, error: "owner, repo and path are required" }, true);
        const params = new URLSearchParams({ path: filePath, ref: String(args.ref || "") });
        const payload = await bridgeFetch(
          `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/download?${params}`,
        );
        if (!payload?.base64) return respond({ ok: false, error: "GitHub returned no file data" }, true);
        const buffer = Buffer.from(payload.base64, "base64");
        if (buffer.length > MAX_DOWNLOAD_BYTES) {
          return respond({ ok: false, error: "File is larger than the 25 MB workspace download limit." }, true);
        }
        const destination = resolvePath(args.destination || payload.name || path.basename(filePath));
        assertAppTarget(destination, "download into " + relPath(destination));
        if (args.overwrite === false && fssync.existsSync(destination)) {
          return respond({ ok: false, error: relPath(destination) + " already exists" }, true);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return respond({ ok: true, path: relPath(destination), bytes: buffer.length, source: payload.path });
      }
      if (name === "github_download_zip") {
        assertResearchGate(name);
        if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled for this workspace." }, true);
        const owner = String(args.owner || "").trim();
        const repo = String(args.repo || "").trim();
        if (!owner || !repo) return respond({ ok: false, error: "owner and repo are required" }, true);
        const ref = String(args.ref || "");
        const response = await fetch(
          `${BRIDGE_URL}/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip?ref=${encodeURIComponent(ref)}`,
          { signal: AbortSignal.timeout(180000) },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "GitHub ZIP download failed (HTTP " + response.status + ")");
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_ZIP_BYTES) {
          return respond({ ok: false, error: "Repository ZIP is larger than the 200 MB workspace limit." }, true);
        }
        const destination = resolvePath(args.destination || `${owner}-${repo}.zip`);
        assertAppTarget(destination, "download into " + relPath(destination));
        if (args.overwrite === false && fssync.existsSync(destination)) {
          return respond({ ok: false, error: relPath(destination) + " already exists" }, true);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return respond({ ok: true, path: relPath(destination), bytes: buffer.length });
      }
      if (name === "download_url") {
        assertResearchGate(name);
        if (!TRUSTED) return respond({ ok: false, error: "Writes are disabled. Enable trusted workspace in Coding mode." }, true);
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return respond({ ok: false, error: "Only http(s) URLs are supported" }, true);
        const parsed = new URL(url);
        const fallbackName = decodeURIComponent(path.basename(parsed.pathname)) || "download.bin";
        const destination = resolvePath(args.path || fallbackName);
        assertAppTarget(destination, "download into " + relPath(destination));
        if (args.overwrite === false && fssync.existsSync(destination)) {
          return respond({ ok: false, error: relPath(destination) + " already exists" }, true);
        }
        const response = await fetch(url, {
          redirect: "follow",
          headers: { "User-Agent": "3D-Creator-Studio/0.1" },
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error("Download failed: HTTP " + response.status);
        const declared = Number(response.headers.get("content-length") || 0);
        if (declared > MAX_DOWNLOAD_BYTES) {
          return respond({ ok: false, error: "File is larger than the 25 MB workspace download limit." }, true);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_DOWNLOAD_BYTES) {
          return respond({ ok: false, error: "File is larger than the 25 MB workspace download limit." }, true);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return respond({
          ok: true,
          path: relPath(destination),
          bytes: buffer.length,
          contentType: response.headers.get("content-type") || "",
        });
      }
      if (name === "github_create_repo") {
        return respond(
          await bridgeFetch("/api/github/repos", {
            method: "POST",
            body: {
              name: args.name,
              description: args.description || "",
              private: Boolean(args.private),
              autoInit: args.autoInit !== false,
              org: args.org || "",
            },
          }),
        );
      }
      if (name === "github_push_files") {
        assertResearchGate(name);
        return respond(
          await bridgeFetch("/api/github/push", {
            method: "POST",
            body: {
              owner: args.owner,
              repo: args.repo,
              branch: args.branch || "",
              message: args.message || "Update from AI Creator Studio",
              files: args.files || [],
            },
          }),
        );
      }
      if (name === "github_create_issue") {
        return respond(
          await bridgeFetch("/api/github/issues", {
            method: "POST",
            body: { owner: args.owner, repo: args.repo, title: args.title, body: args.body || "" },
          }),
        );
      }
      if (name === "github_create_pull_request") {
        return respond(
          await bridgeFetch("/api/github/pulls", {
            method: "POST",
            body: {
              owner: args.owner,
              repo: args.repo,
              title: args.title,
              head: args.head,
              base: args.base,
              body: args.body || "",
            },
          }),
        );
      }
    }
    return respond({ ok: false, error: `Unknown coding tool: ${name}` }, true);
  } catch (error) {
    return respond({ ok: false, error: error.message }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
