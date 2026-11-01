import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";

const APP_SECRET = "TwilightStudio.AI-Creator-Studio.2026.License.v1";
const MAGIC = Buffer.from("TWIXLIC1");
const SERVER_URL = (
  process.env.TWIX_LICENSE_SERVER || "https://spearhead-versus-stimulant.ngrok-free.dev"
).replace(/\/+$/, "");
const SERVER_USER = process.env.TWIX_LICENSE_USER || "admin";
const SERVER_PASS = process.env.TWIX_LICENSE_PASS || "380112";
const MACHINE_FILE = "license-machine.id";
const LICENSE_FILE = ".twix-license.dat";
const TOKEN_TTL_MS = 20 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 12000;

let cachedToken = "";
let cachedTokenAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase();
}

function maskKey(value) {
  const key = String(value || "").trim().toUpperCase();
  if (!key) return "";
  const parts = key.split("-");
  if (parts.length === 3) {
    return `${parts[0]}-${parts[1].replace(/./g, "*")}-${parts[2]}`;
  }
  return key.length <= 6 ? key : `${key.slice(0, 4)}${"*".repeat(Math.max(2, key.length - 6))}${key.slice(-2)}`;
}

function legacyFingerprint() {
  let mac = "";
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") {
          mac = net.mac;
          break;
        }
      }
      if (mac) break;
    }
  } catch {}
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {}
  const raw = [os.hostname(), username, mac, process.platform].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The Windows MachineGuid is stable across network adapter changes and is not
 * copied with the user's Documents folder, so it is a better activation bind
 * than a MAC address.
 */
function hardwareFingerprint() {
  let machineGuid = "";
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true },
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (match) machineGuid = match[1];
    } catch {}
  }
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {}
  const raw = [machineGuid || os.hostname(), username, process.platform].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function setHidden(file) {
  if (process.platform !== "win32") return;
  try {
    execFile("attrib", ["+h", file], () => {});
  } catch {}
}

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createLicenseService({ dataDir, documentsDir }) {
  const licenseDir = documentsDir || dataDir;
  const licensePath = path.join(licenseDir, LICENSE_FILE);
  const machinePath = path.join(licenseDir, MACHINE_FILE);

  async function ensureDir() {
    await fs.mkdir(licenseDir, { recursive: true }).catch(() => {});
  }

  function machineId() {
    try {
      if (fssync.existsSync(machinePath)) {
        const value = fssync.readFileSync(machinePath, "utf8").trim();
        if (value) return value;
      }
    } catch {}
    const value = randomUUID();
    try {
      fssync.mkdirSync(licenseDir, { recursive: true });
      fssync.writeFileSync(machinePath, value, "utf8");
      setHidden(machinePath);
    } catch {}
    return value;
  }

  function deriveKey(salt, fingerprint = hardwareFingerprint()) {
    return scryptSync(`${fingerprint}|${APP_SECRET}`, salt, 32);
  }

  async function writeLicense(data) {
    await ensureDir();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
    // A hidden attribute on Windows can make a direct overwrite fail with
    // EPERM. Remove the old file first, then write the new encrypted payload.
    try {
      await fs.unlink(licensePath);
    } catch {}
    await fs.writeFile(licensePath, payload, { mode: 0o600 });
    setHidden(licensePath);
  }

  function decodeLicense(raw, fingerprint) {
    try {
      if (raw.length < MAGIC.length + 16 + 12 + 16) return null;
      if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
      let offset = MAGIC.length;
      const salt = raw.subarray(offset, offset + 16);
      offset += 16;
      const iv = raw.subarray(offset, offset + 12);
      offset += 12;
      const tag = raw.subarray(offset, offset + 16);
      offset += 16;
      const ciphertext = raw.subarray(offset);
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt, fingerprint), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const data = JSON.parse(plain.toString("utf8"));
      if (!data || typeof data !== "object" || !data.key || !data.activationToken) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function readLicense() {
    try {
      const raw = await fs.readFile(licensePath);
      const data = decodeLicense(raw, hardwareFingerprint());
      if (data) return data;
      const legacy = decodeLicense(raw, legacyFingerprint());
      if (!legacy) return null;
      // Migrate a file written by an earlier build to the stable MachineGuid key.
      try {
        await writeLicense(legacy);
      } catch {}
      return legacy;
    } catch {
      return null;
    }
  }

  async function clearLicense() {
    try {
      await fs.unlink(licensePath);
    } catch {}
  }

  async function login(force = false) {
    if (!force && cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) {
      return cachedToken;
    }
    const res = await fetchWithTimeout(`${SERVER_URL}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ username: SERVER_USER, password: SERVER_PASS }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`License server login failed (${res.status}).`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("License server returned an invalid login response.");
    }
    if (!data?.token) throw new Error("License server did not return a token.");
    cachedToken = data.token;
    cachedTokenAt = Date.now();
    return cachedToken;
  }

  async function request(pathname, options = {}, retry = true) {
    const token = await login();
    const res = await fetchWithTimeout(`${SERVER_URL}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.status === 401 && retry) {
      cachedToken = "";
      cachedTokenAt = 0;
      return request(pathname, options, false);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`License server error (${res.status}): ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("License server returned invalid JSON.");
    }
  }

  async function findAll() {
    const data = await request("/api/paid_licenses");
    return data?.records && typeof data.records === "object" ? data.records : {};
  }

  async function findLicense(key) {
    const records = await findAll();
    const normalized = normalizeKey(key);
    if (records[normalized]) return { ...records[normalized] };
    for (const [recordKey, record] of Object.entries(records)) {
      if (normalizeKey(record?.key || recordKey) === normalized) return { ...record };
    }
    return null;
  }

  async function updateLicense(record) {
    const key = normalizeKey(record.key);
    const body = { ...record, id: key, key };
    return request("/api/paid_licenses", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  function expiryState(record) {
    const raw = record?.expires_at || record?.expiry || "";
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) return { expired: false, expiresAt: raw, daysLeft: null };
    const ms = date.getTime() - Date.now();
    return {
      expired: ms <= 0,
      expiresAt: date.toISOString(),
      daysLeft: Math.max(0, Math.ceil(ms / 86400000)),
    };
  }

  function publicLicense(record) {
    const expiry = expiryState(record);
    return {
      key: maskKey(record.key),
      product: record.product || "AI Creator Studio",
      accountId: record.account_id || "",
      expiresAt: expiry.expiresAt,
      daysLeft: expiry.daysLeft,
      status: record.status || "active",
    };
  }

  async function status() {
    const checkedAt = nowIso();
    const stored = await readLicense();
    if (!stored) {
      return {
        licensed: false,
        status: "inactive",
        reason: "No product key is activated on this PC.",
        license: null,
        checkedAt,
      };
    }
    let record;
    try {
      record = await findLicense(stored.key);
    } catch (error) {
      return {
        licensed: false,
        status: "offline",
        reason:
          "Could not reach the Twilight Studio license server. Check your internet connection and try again.",
        detail: String(error?.message || error),
        license: publicLicense(stored),
        checkedAt,
      };
    }
    if (!record) {
      return {
        licensed: false,
        status: "invalid",
        reason: "This product key is no longer on the license server.",
        license: publicLicense(stored),
        checkedAt,
      };
    }
    const expiry = expiryState(record);
    if (expiry.expired) {
      return {
        licensed: false,
        status: "expired",
        reason: `This product key expired on ${expiry.expiresAt || "an unknown date"}. Enter a new key to continue.`,
        license: publicLicense(record),
        checkedAt,
      };
    }
    if (String(record.status || "active").toLowerCase() !== "active") {
      return {
        licensed: false,
        status: String(record.status || "invalid"),
        reason: `This product key is ${record.status}.`,
        license: publicLicense(record),
        checkedAt,
      };
    }
    const machine = machineId();
    if (String(stored.machineId || "") !== machine) {
      return {
        licensed: false,
        status: "in-use",
        reason: "This activation belongs to another PC. Enter a new product key.",
        license: publicLicense(record),
        checkedAt,
      };
    }
    if (
      record.used !== true ||
      String(record.used_by || "") !== machine ||
      String(record.activation_token || "") !== String(stored.activationToken || "")
    ) {
      return {
        licensed: false,
        status: "in-use",
        reason: "This product key has already been used on another device.",
        license: publicLicense(record),
        checkedAt,
      };
    }
    return {
      licensed: true,
      status: "active",
      reason: "License active.",
      license: publicLicense(record),
      checkedAt,
    };
  }

  async function activate(inputKey) {
    const key = normalizeKey(inputKey);
    if (!key) {
      return { ok: false, error: "Enter your product key." };
    }
    let record;
    try {
      record = await findLicense(key);
    } catch (error) {
      return {
        ok: false,
        error:
          "Could not reach the Twilight Studio license server. Check your internet connection and try again.",
        detail: String(error?.message || error),
      };
    }
    if (!record) {
      return { ok: false, error: "That product key was not found. Check the key and try again." };
    }
    const expiry = expiryState(record);
    if (expiry.expired) {
      return {
        ok: false,
        error: `This product key expired on ${expiry.expiresAt || "an unknown date"}. Please request a new key.`,
      };
    }
    if (String(record.status || "active").toLowerCase() !== "active") {
      return { ok: false, error: `This product key is ${record.status}.` };
    }

    const machine = machineId();
    const existing = await readLicense();
    if (record.used === true) {
      const sameMachine =
        existing &&
        normalizeKey(existing.key) === key &&
        String(existing.machineId || "") === machine &&
        String(existing.activationToken || "") === String(record.activation_token || "") &&
        String(record.used_by || "") === machine;
      if (sameMachine) {
        const current = await status();
        return { ok: true, status: current };
      }
      return {
        ok: false,
        error: "This product key has already been used on another device. Each key can only be activated once.",
      };
    }

    const activationToken = randomBytes(24).toString("hex");
    const usedAt = nowIso();
    const next = {
      ...record,
      key,
      used: true,
      used_by: machine,
      used_at: usedAt,
      activation_token: activationToken,
      activated_app: "AI Creator Studio by Twilight Studio",
    };
    try {
      await updateLicense(next);
    } catch (error) {
      return {
        ok: false,
        error: "Could not register this activation with the license server. Try again.",
        detail: String(error?.message || error),
      };
    }

    // Re-read to make sure another device did not claim the key at the same time.
    let verify = null;
    try {
      verify = await findLicense(key);
    } catch {}
    if (
      !verify ||
      String(verify.used_by || "") !== machine ||
      String(verify.activation_token || "") !== activationToken
    ) {
      return {
        ok: false,
        error: "This product key was just claimed by another device. Please contact Twilight Studio.",
      };
    }

    try {
      await writeLicense({
        key,
        machineId: machine,
        activationToken,
        activatedAt: usedAt,
        product: record.product || "AI Creator Studio",
        accountId: record.account_id || "",
        expiresAt: record.expires_at || "",
      });
    } catch (error) {
      // Roll the server record back so the key is not burned if the local
      // encrypted activation file could not be written.
      try {
        await updateLicense({ ...record, key });
      } catch {}
      return {
        ok: false,
        error: "The activation could not be saved on this PC. Please try again.",
        detail: String(error?.message || error),
      };
    }

    let current;
    try {
      current = await status();
    } catch {
      const expiry = expiryState(record);
      current = {
        licensed: true,
        status: "active",
        reason: "License active.",
        license: publicLicense({
          ...record,
          key,
          account_id: record.account_id || "",
          expires_at: expiry.expiresAt || record.expires_at || "",
        }),
        checkedAt: nowIso(),
      };
    }
    return { ok: true, status: current };
  }

  return { status, activate, clearLicense };
}
