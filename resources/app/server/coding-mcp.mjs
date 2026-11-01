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
const TRUSTED = process.env.TWIX_CODING_TRUSTED === "1";
const UNITY_PORT = process.env.TWIX_UNITY_BRIDGE_PORT ? Number(process.env.TWIX_UNITY_BRIDGE_PORT) : null;
const BRIDGE_URL = process.env.TWIX_BRIDGE_URL || "";
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
      if (name === "reference_search") {
        const query = String(args.query || "").trim();
        if (!query) return respond({ ok: false, error: "query is required" }, true);
        const limit = Math.max(1, Math.min(30, Number(args.limit ?? 8)));
        const payload = await bridgeFetch(
          `/api/references/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        );
        return respond(payload, false);
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
