import { createHash } from "node:crypto";

/**
 * Minimal Git LFS client for GitHub.
 *
 * The studio no longer rejects large assets. Files above the blob threshold are
 * uploaded through the Git LFS batch API and the repository stores a small
 * pointer file, exactly like a normal `git lfs` checkout.
 */

export const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const LFS_ACCEPT = "application/vnd.git-lfs+json";
const USER_AGENT = "AI-Creator-Studio-Twilight";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function isLfsPointer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.length > 2048) return false;
  return buffer.subarray(0, 64).toString("utf8").startsWith(LFS_POINTER_PREFIX);
}

export function parseLfsPointer(buffer) {
  if (!isLfsPointer(buffer)) return null;
  const text = buffer.toString("utf8");
  const oid = /oid sha256:([a-f0-9]{64})/i.exec(text)?.[1] || "";
  const size = Number(/size (\d+)/i.exec(text)?.[1] || 0);
  if (!oid || !Number.isFinite(size)) return null;
  return { oid, size };
}

export function lfsPointerText(oid, size) {
  return `${LFS_POINTER_PREFIX}\noid sha256:${oid}\nsize ${size}\n`;
}

export function lfsPatternsFor(paths) {
  const extensions = new Set();
  for (const value of paths) {
    const name = String(value || "");
    const match = /\.([a-z0-9]{2,12})$/i.exec(name);
    if (match) extensions.add("*." + match[1].toLowerCase());
  }
  return [...extensions].sort().map((pattern) => `${pattern} filter=lfs diff=lfs merge=lfs -text`);
}

function authHeaders(token, scheme) {
  if (scheme === "bearer") return { Authorization: "Bearer " + token };
  return { Authorization: "Basic " + Buffer.from("x-access-token:" + token).toString("base64") };
}

function endpoint(owner, repo) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/lfs`;
}

async function requestBatch(owner, repo, token, operation, objects, scheme = "basic") {
  const response = await fetch(endpoint(owner, repo) + "/objects/batch", {
    method: "POST",
    headers: {
      Accept: LFS_ACCEPT,
      "Content-Type": LFS_ACCEPT,
      "User-Agent": USER_AGENT,
      ...authHeaders(token, scheme),
    },
    body: JSON.stringify({ operation, transfers: ["basic"], hash_algo: "sha256", objects }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.message || `Git LFS HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function batchWithFallback(owner, repo, token, operation, objects) {
  try {
    return await requestBatch(owner, repo, token, operation, objects, "basic");
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    return requestBatch(owner, repo, token, operation, objects, "bearer");
  }
}

/** Upload one buffer and return the text of the pointer that should be committed. */
export async function lfsUploadBuffer(owner, repo, token, buffer) {
  const oid = sha256(buffer);
  const size = buffer.length;
  const data = await batchWithFallback(owner, repo, token, "upload", [{ oid, size }]);
  const object = Array.isArray(data?.objects) ? data.objects[0] : null;
  if (!object) throw new Error("Git LFS did not return an upload action.");
  if (object.error) throw new Error(object.error.message || "Git LFS rejected the upload.");
  const action = object.actions?.upload;
  if (!action?.href) throw new Error("Git LFS returned no upload URL.");
  const response = await fetch(action.href, {
    method: action.method || "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "User-Agent": USER_AGENT,
      ...(action.header || {}),
    },
    body: buffer,
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Git LFS upload failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const verify = object.actions?.verify;
  if (verify?.href) {
    await fetch(verify.href, {
      method: verify.method || "POST",
      headers: {
        "Content-Type": LFS_ACCEPT,
        "User-Agent": USER_AGENT,
        ...(verify.header || {}),
      },
      body: JSON.stringify({ oid, size }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
  }
  return lfsPointerText(oid, size);
}

/** Resolve a committed LFS pointer into the real file bytes. */
export async function lfsDownloadObject(owner, repo, token, oid, size) {
  const data = await batchWithFallback(owner, repo, token, "download", [{ oid, size }]);
  const object = Array.isArray(data?.objects) ? data.objects[0] : null;
  if (!object) throw new Error("Git LFS did not return a download action.");
  if (object.error) throw new Error(object.error.message || "Git LFS rejected the download.");
  const action = object.actions?.download;
  if (!action?.href) throw new Error("Git LFS returned no download URL.");
  const response = await fetch(action.href, {
    headers: { "User-Agent": USER_AGENT, ...(action.header || {}) },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    throw new Error(`Git LFS download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Merge the LFS rules a workspace needs into the existing .gitattributes text
 * without dropping any rule the user already has.
 */
export function mergeLfsAttributes(existing, paths) {
  const patterns = lfsPatternsFor(paths);
  if (!patterns.length) return existing || "";
  const lines = String(existing || "").replace(/\r\n/g, "\n").split("\n");
  const present = new Set(lines.map((line) => line.trim()));
  const additions = patterns.filter((line) => !present.has(line));
  if (!additions.length) return existing || "";
  const base = String(existing || "").replace(/\s+$/, "");
  return (base ? base + "\n" : "") + additions.join("\n") + "\n";
}
