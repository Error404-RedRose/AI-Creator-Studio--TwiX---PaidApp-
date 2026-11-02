/**
 * Creator Studio command safety.
 *
 * A single, dependency-free classifier used by the coding bridge and by the
 * desktop UI before any shell command runs. It understands both Windows
 * (cmd / PowerShell) and Linux / macOS shell syntax, extracts delete targets
 * and decides whether a command needs an explicit user approval.
 *
 * The goal is precision, not paranoia: ordinary build and test commands stay
 * silent, while deletes of projects, home folders, system paths, disks, Git
 * history, databases and remote-script pipes are blocked until the user says
 * Allow.
 */

import path from "node:path";

export const SEVERITY_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

const SAFE_DELETE_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "output",
  "coverage",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  "tmp",
  "temp",
  "target",
  "obj",
  "bin",
  "release",
  "dist-electron",
  "out-tsc",
  "logs",
  "htmlcov",
  ".nyc_output",
  ".angular",
  ".svelte-kit",
  ".astro",
  ".output",
  ".vercel",
  ".netlify",
  ".expo",
  ".gradle",
  ".dart_tool",
  ".serverless",
  ".terraform",
  ".venv",
  "venv",
  "vendor",
  "storybook-static",
  "testresults",
]);

// Read-only inspection commands: listing, reading, searching, Git history and
// version checks. These never modify the machine, so they skip the destructive
// rules entirely. Anything that could write, delete or execute is excluded.
const READ_ONLY_COMMAND =
  /^\s*(?:(?:powershell|pwsh)(?:\.exe)?\b[^\n]*?-command\s+["']?)?\s*(?:get-[a-z]+|test-path|resolve-path|select-string|select-object|where-object|foreach-object|sort-object|group-object|measure-object|compare-object|format-table|format-list|format-wide|out-string|out-host|write-output|write-host|dir|ls|gci|gc|cat|type|findstr|find|where|which|echo|pwd|cd|chdir|set-location|pushd|popd|git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|npm\s+(?:ls|list|view|outdated|--version)|node\s+--version|python\s+--version|dotnet\s+--version|tsc\s+--version|head|tail|more|wc|stat|file|du|df|grep|rg|tree|hostname|whoami|systeminfo|start-sleep)\b/i;

// Any sign that the command writes, deletes, installs or executes something
// new. When one is present the read-only shortcut is skipped.
const WRITE_OR_EXEC_INTENT =
  /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)\b|\b(?:shred|truncate)\b|(?:^|[^<>])>{1,2}(?!\s*&)|(?:^|[|;&(]\s*|\b(?:then|do)\s+)(?:set-content|add-content|out-file|new-item|remove-item|del|erase|rmdir|rd|rm|move-item|copy-item|rename-item|set-item|clear-content|tee-object|start-process|start-job|invoke-expression|iex|invoke-command|stop-process|taskkill|kill|pkill|curl|wget|iwr|irm|set-executionpolicy|reg\s+add|reg\s+delete|schtasks|sc\s+create|sc\s+delete|npm\s+(?:install|i|ci|uninstall)|yarn\s+(?:add|install)|pnpm\s+(?:add|install)|git\s+(?:push|commit|reset|clean|checkout|restore|merge|rebase|apply)|node\s+-e|python\s+-c|pip\s+install|dotnet\s+(?:build|run|test|publish)|cargo\s+(?:build|run)|go\s+(?:build|run)|make|cmake|mkdir|md|touch|chmod|chown)\b/i;

const RULES = [
  {
    id: "remote-pipe-shell",
    category: "Remote code execution",
    severity: "critical",
    pattern: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish|dash|powershell|pwsh|iex|invoke-expression|python3?|node|perl|ruby)\b/i,
    reason:
      "Downloads a script from the internet and pipes it straight into a shell, so an unknown website can run any code on this PC.",
    summary: "Executes a script downloaded from the internet without review.",
  },
  {
    id: "encoded-powershell",
    category: "Remote code execution",
    severity: "high",
    pattern: /\b(?:powershell|pwsh)\b[^\n]*(?:-(?:enc|encodedcommand)\b|-e\s+[a-z0-9+/=]{40,})/i,
    reason:
      "Encoded PowerShell hides its real contents. This is a common way to run malware or bypass inspection.",
    summary: "Runs obfuscated PowerShell that cannot be reviewed.",
  },
  {
    id: "iex-download",
    category: "Remote code execution",
    severity: "critical",
    pattern: /\b(?:iex|invoke-expression)\b[^\n]*(?:downloadstring|invoke-webrequest|iwr|curl|wget)\b/i,
    reason: "Downloads code and executes it in memory, bypassing normal file checks.",
    summary: "Executes downloaded code directly in memory.",
  },
  {
    id: "fork-bomb",
    category: "System denial of service",
    severity: "critical",
    pattern: /:\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Fork bombs spawn processes until the computer stops responding.",
    summary: "Crashes this PC by exhausting all processes.",
  },
  {
    id: "format-drive",
    category: "Disk destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)format(?:\.com)?\s+[a-z]:/i,
    reason: "Formats a disk drive and destroys every file on it.",
    summary: "Formats a disk drive.",
  },
  {
    id: "filesystem-create",
    category: "Disk destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)mkfs(?:\.[a-z0-9]+)?\b/i,
    reason: "Creates a new filesystem over an existing partition and destroys its data.",
    summary: "Reformats a filesystem.",
  },
  {
    id: "dd-device",
    category: "Disk destruction",
    severity: "critical",
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk|mapper)/i,
    reason: "Writes raw data over a disk device, which permanently destroys the disk's contents.",
    summary: "Overwrites a raw disk device.",
  },
  {
    id: "redirect-block-device",
    category: "Disk destruction",
    severity: "critical",
    pattern: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk|mapper)/i,
    reason: "Redirects output onto a raw disk device and destroys its contents.",
    summary: "Writes directly over a disk device.",
  },
  {
    id: "diskpart-clean",
    category: "Disk destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)diskpart\b[^\n]*(?:clean|format|delete\s+(?:partition|volume))/i,
    reason: "DiskPart can erase partitions and volumes, including the Windows system disk.",
    summary: "Erases a disk partition or volume.",
  },
  {
    id: "partition-tools",
    category: "Disk destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)(?:fdisk|parted|wipefs|shreddisk)\b/i,
    reason: "Partition tools can destroy disk tables and make drives unbootable.",
    summary: "Modifies or wipes a disk partition table.",
  },
  {
    id: "boot-config",
    category: "System destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)bcdedit\b/i,
    reason: "Changes the Windows boot configuration. A wrong edit can stop Windows from starting.",
    summary: "Modifies the boot configuration.",
  },
  {
    id: "shadow-copy-delete",
    category: "System destruction",
    severity: "critical",
    pattern: /\bvssadmin\b[^\n]*\bdelete\b[^\n]*\bshadows?\b/i,
    reason: "Deletes Windows shadow copies and backups. This is a common ransomware step and removes recovery points.",
    summary: "Deletes system backup snapshots.",
  },
  {
    id: "registry-delete",
    category: "System destruction",
    severity: "critical",
    pattern: /(?:^|[;&|]\s*)reg\s+delete\s+(?:HKLM|HKEY_LOCAL_MACHINE)/i,
    reason: "Deletes a machine-wide registry key, which can break Windows or installed programs.",
    summary: "Deletes a critical Windows registry key.",
  },
  {
    id: "event-log-clear",
    category: "System destruction",
    severity: "high",
    pattern: /\bwevtutil\b[^\n]*\bcl\b/i,
    reason: "Clears Windows event logs and removes the audit trail of what happened.",
    summary: "Erases Windows event logs.",
  },
  {
    id: "security-disable",
    category: "Security tampering",
    severity: "high",
    pattern: /\b(?:set-mppreference\b[^\n]*disablerealtimemonitoring|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off|sc\s+stop\s+(?:windefend|mpssvc)|net\s+stop\s+(?:windefend|mpssvc))/i,
    reason: "Turns off Windows Defender or the firewall, leaving the PC unprotected.",
    summary: "Disables built-in security protection.",
  },
  {
    id: "execution-policy",
    category: "Security tampering",
    severity: "high",
    pattern: /\bset-executionpolicy\b[^\n]*(?:unrestricted|bypass)/i,
    reason: "Allows unsigned PowerShell scripts to run, which makes malware easier to execute.",
    summary: "Unlocks unrestricted PowerShell script execution.",
  },
  {
    id: "user-account-delete",
    category: "System destruction",
    severity: "high",
    pattern: /\bnet\s+(?:user|localgroup)\b[^\n]*\/delete\b/i,
    reason: "Deletes a Windows user or group. This can lock you out of the computer.",
    summary: "Deletes a Windows account or group.",
  },
  {
    id: "service-schedule-delete",
    category: "System destruction",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)(?:sc\s+delete|schtasks\b[^\n]*\/delete)\b/i,
    reason: "Deletes a Windows service or scheduled task, which can break startup or background updates.",
    summary: "Deletes a Windows service or scheduled task.",
  },
  {
    id: "shutdown",
    category: "Power control",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff|halt|restart-computer|stop-computer|logoff)\b(?:\s+[^\n]*)?/i,
    reason: "Shuts down, restarts or signs out of the computer and can interrupt unsaved work.",
    summary: "Shuts down or restarts this PC.",
  },
  {
    id: "kill-critical-process",
    category: "System destruction",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)(?:taskkill|stop-process|kill|pkill|killall|killall5)\b[^\n]*(?:explorer|winlogon|csrss|lsass|wininit|services\.exe|svchost|systemd|init\b|kernel_task)/i,
    reason: "Terminates a critical system process, which can crash the desktop or force a reboot.",
    summary: "Kills a critical system process.",
  },
  {
    id: "kill-all",
    category: "System denial of service",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)(?:kill\s+-9\s+-1|killall5|pkill\s+-9\s+-f\s+\.\*|taskkill\b[^\n]*\/im\s+\*)/i,
    reason: "Kills every running process and can force a restart with unsaved work lost.",
    summary: "Terminates every running process.",
  },
  {
    id: "recursive-permissions",
    category: "System destruction",
    severity: "critical",
    pattern: /\b(?:chmod|chown)\s+-R\b[^\n]*(?:\s\/\s*$|\s\/(?:etc|bin|sbin|usr|boot|lib|dev|sys|proc|var)\b)/i,
    reason: "Recursively rewrites permissions or ownership on system folders, which can make Linux unusable.",
    summary: "Rewrites permissions across system folders.",
  },
  {
    id: "take-ownership",
    category: "System destruction",
    severity: "high",
    pattern: /\b(?:takeown|icacls)\b[^\n]*(?:c:\\windows|system32|program files)/i,
    reason: "Takes ownership of Windows system files and bypasses their protection.",
    summary: "Takes ownership of Windows system files.",
  },
  {
    id: "git-history-loss",
    category: "Project data loss",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s+\.|restore\s+\.|push\b[^\n]*--force|push\b[^\n]*\s-f\b)/i,
    reason:
      "Discards uncommitted work or rewrites Git history. Changes that were never committed cannot be recovered.",
    summary: "Discards uncommitted work or rewrites Git history.",
  },
  {
    id: "database-drop",
    category: "Database destruction",
    severity: "high",
    pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|dropdatabase\s*\()/i,
    reason: "Drops or empties database tables. The data is permanently lost unless you have a backup.",
    summary: "Drops or truncates database data.",
  },
  {
    id: "database-delete-all",
    category: "Database destruction",
    severity: "high",
    pattern: /\bdelete\s+from\s+[`"\w.]+\s*(?:;|$)/i,
    reason: "A DELETE without a WHERE clause removes every row in the table.",
    summary: "Deletes every row in a database table.",
  },
  {
    id: "docker-prune",
    category: "Data loss",
    severity: "high",
    pattern: /\bdocker\b[^\n]*(?:system\s+prune\b[^\n]*--volumes|volume\s+rm\b|rm\s+-f\b[^\n]*\$\(docker\s+ps)/i,
    reason: "Removes Docker containers or volumes, which can delete databases and uploaded data.",
    summary: "Deletes Docker volumes or containers.",
  },
  {
    id: "cloud-destroy",
    category: "Cloud data destruction",
    severity: "high",
    pattern: /(?:^|[;&|]\s*)(?:terraform\s+destroy|aws\s+s3\s+rb\b[^\n]*--force|kubectl\s+delete\s+(?:namespace|pvc|pvs)\b|firebase\s+\w+\s+delete\b)/i,
    reason: "Destroys live cloud infrastructure or storage that may hold production data.",
    summary: "Destroys cloud infrastructure or storage.",
  },
  {
    id: "node-delete",
    category: "Scripted file deletion",
    severity: "high",
    pattern: /\b(?:fs\.(?:rm|rmSync|rmdirSync)\([^)]*recursive\s*:\s*true|require\(["']fs["']\)\.rmSync\()/i,
    reason: "A Node script deletes files recursively, hidden inside code instead of a visible shell command.",
    summary: "Deletes files recursively through Node code.",
  },
  {
    id: "python-delete",
    category: "Scripted file deletion",
    severity: "high",
    pattern: /\bshutil\.rmtree\s*\(/i,
    reason: "A Python script deletes an entire directory tree.",
    summary: "Deletes an entire directory tree through Python code.",
  },
];

function flatten(command) {
  return String(command || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, " ; ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function cleanToken(token) {
  return token
    .replace(/^["'`]+/, "")
    .replace(/["'`,;)]+$/, "")
    .replace(/^\(+/, "")
    .trim();
}

function extractDeleteTargets(flat) {
  const targets = [];
  const pushTokens = (args) => {
    for (const raw of String(args || "").split(/\s+/)) {
      const token = cleanToken(raw);
      if (!token) continue;
      if (token === "/" || token === "\\") {
        targets.push(token);
        continue;
      }
      // Drop flags and Windows switches, but keep real paths and names.
      if (/^-{1,2}/.test(token)) continue;
      if (/^\/[a-zA-Z]{1,3}$/.test(token)) continue;
      if (/^\{.*\}$/.test(token)) continue;
      if (/^(?:-path|-literalpath)$/i.test(token)) continue;
      if (token.length > 300) continue;
      targets.push(token);
    }
  };
  const patterns = [
    /\brm\b([^;&|]+)/gi,
    /\brimraf\b([^;&|]+)/gi,
    /\bdel-cli\b([^;&|]+)/gi,
    /\bri\b\s+-([^;&|]+)/gi,
    /\bdel\b([^;&|]+)/gi,
    /\berase\b([^;&|]+)/gi,
    /\brd\b([^;&|]+)/gi,
    /\brmdir\b([^;&|]+)/gi,
    /\bremove-item\b([^;&|]+)/gi,
    /\brmtree\s*\(([^)]*)\)/gi,
    /\brmSync\s*\(([^)]*)\)/gi,
    /\bshred\b([^;&|]+)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(flat))) {
      pushTokens(match[1]);
      if (targets.length >= 10) break;
    }
  }
  const findMatch = flat.match(/\bfind\b([^;&|]+?)\s+-delete\b/i);
  if (findMatch) pushTokens(findMatch[1]);
  return [...new Set(targets)].slice(0, 10);
}

function targetZone(target, cwd) {
  let value = String(target || "").trim().replace(/^["'`]+|["'`,;)]+$/g, "");
  if (!value) return "unknown";
  let norm = value.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") || "/";
  const normalizedCwd = cwd
    ? path.resolve(String(cwd)).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "")
    : "";
  let resolved = norm;
  const profileShorthand = /^(?:~|\$home|%userprofile%|%homedrive%%homepath%)/i.test(value);
  if (normalizedCwd && !profileShorthand && !path.isAbsolute(value) && norm !== "/" && !/^[a-z]:/i.test(norm)) {
    try {
      resolved = path.resolve(String(cwd), value).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    } catch {
      resolved = norm;
    }
  }
  if (normalizedCwd && (resolved === normalizedCwd || norm === "." || norm === "./")) {
    return "project";
  }
  if (normalizedCwd && resolved.startsWith(normalizedCwd + "/")) {
    if (/(^|\/)\.git(\/|$)/.test(resolved)) return "git";
    const inner = resolved.replace(/[*?]+$/g, "").split("/").filter(Boolean).pop() || "";
    return SAFE_DELETE_NAMES.has(inner) ? "build" : "workspace";
  }
  if (
    norm === "/" ||
    norm === "/*" ||
    norm === "//" ||
    norm === "*" ||
    norm === "~" ||
    norm === "$home" ||
    norm === "%userprofile%" ||
    norm === "%homedrive%%homepath%" ||
    /^[a-z]:$/.test(norm) ||
    /^[a-z]:\/\*?$/.test(norm)
  ) {
    return "root";
  }
  if (
    /(^|\/)(windows|system32|syswow64|winsxs|program files(?: \(x86\))?|programdata|recovery)(\/|$)/.test(norm) ||
    /(^|\/)appdata(\/|$)/.test(norm)
  ) {
    return "system";
  }
  if (/^\/(etc|bin|sbin|usr|boot|lib|lib64|dev|sys|proc|var|opt)(\/|$)/.test(norm)) {
    return "system";
  }
  if (
    /^\/(home|users|root)(\/|$)/.test(norm) ||
    /^c:\/users(\/|$)/.test(norm) ||
    norm.startsWith("~/") ||
    /^(%userprofile%|\$home|~)(\/|$)/.test(norm)
  ) {
    return "home";
  }
  if (/(^|\/)\.git(\/|$)/.test(norm)) return "git";
  if (/(^|\/)\.ssh(\/|$)/.test(norm) || /(^|\/)\.aws(\/|$)/.test(norm) || /(^|\/)\.config(\/|$)/.test(norm)) {
    return "secrets";
  }
  const base = norm.replace(/[*?]+$/g, "").split("/").filter(Boolean).pop() || "";
  if (SAFE_DELETE_NAMES.has(base)) return "build";
  if (norm === "." || norm === ".." || norm === "./" || norm === "../" || norm === ".\\") return "project";
  return "unknown";
}

function deletionAssessment(flat, cwd = "") {
  const targets = extractDeleteTargets(flat);
  const recursive =
    /\brm\b[^\n;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)/i.test(flat) ||
    /\b(?:rimraf|del-cli)\b/i.test(flat) ||
    /\bri\b\s+-[a-z]*r[a-z]*/i.test(flat) ||
    /\bri\b\s+-[a-z]*fo\b/i.test(flat) ||
    /\b(?:rd|rmdir)\b[^\n;&|]*\/s\b/i.test(flat) ||
    /\bdel\b[^\n;&|]*\/s\b/i.test(flat) ||
    /\bremove-item\b[^\n;&|]*-recurse\b/i.test(flat) ||
    /\brmtree\s*\(|\brmSync\s*\([^)]*recursive/i.test(flat) ||
    /\bfind\b[^\n;&|]*-delete\b/i.test(flat) ||
    /\bshred\b/i.test(flat);
  const wildcard = targets.some((target) => target.includes("*") || target.includes("?"));
  if (!recursive && !wildcard) {
    return { destructive: false, recursive, wildcard, targets, severity: "safe", reasons: [] };
  }
  const zones = targets.map((target) => targetZone(target, cwd));
  const reasons = [];
  let severity = "medium";
  if (zones.includes("root")) {
    severity = "critical";
    reasons.push("The delete targets a whole drive or the filesystem root, which would remove this PC's files.");
  }
  if (zones.includes("system")) {
    severity = "critical";
    reasons.push("The delete targets Windows or Linux system folders, which can stop the PC from booting.");
  }
  if (zones.includes("home")) {
    severity = "critical";
    reasons.push("The delete targets your home or user profile folder.");
  }
  if (zones.includes("secrets")) {
    severity = "critical";
    reasons.push("The delete targets SSH, cloud or configuration folders that hold credentials.");
  }
  if (zones.includes("git")) {
    severity = "critical";
    reasons.push("The delete targets the .git folder and would destroy the repository history.");
  }
  if (zones.includes("project")) {
    if (severity === "medium") severity = "high";
    reasons.push("The delete targets the project folder you are working in.");
  }
  if (zones.includes("workspace") && severity === "medium") {
    severity = "high";
    reasons.push("This recursive delete targets a folder inside your active project that is not a known build or cache folder.");
  }
  if (wildcard && severity === "medium") {
    severity = "high";
    reasons.push("A wildcard can remove many files at once.");
  }
  if (recursive && severity === "medium" && zones.includes("unknown")) {
    severity = "high";
    reasons.push("This is a recursive delete and the target is not a known safe build folder.");
  }
  if (zones.includes("build") && !zones.some((zone) => zone !== "build" && zone !== "unknown")) {
    severity = "medium";
    reasons.push("Only build or cache output is targeted, so this is normally safe to clean.");
  }
  if (recursive && !targets.length) {
    severity = "high";
    reasons.push("The recursive delete has no clear target and could affect a large area.");
  }
  return { destructive: true, recursive, wildcard, targets, severity, reasons };
}

function maxSeverity(a, b) {
  return (SEVERITY_ORDER[a] || 0) >= (SEVERITY_ORDER[b] || 0) ? a : b;
}

const GENERIC_SUMMARIES = {
  critical: "This command can permanently destroy files, disks or system data on this PC.",
  high: "This command deletes, overwrites or irreversibly changes data.",
  medium: "This command removes build or output files from the project.",
  low: "This command affects one specific file.",
  safe: "No destructive command pattern was detected.",
};

/**
 * Classify a shell command.
 * @param {string} command Raw command text from the coding assistant.
 * @param {{cwd?: string, platform?: string}} [options]
 */
export function assessCommand(command, options = {}) {
  const flat = flatten(command);
  const platform = options.platform || process.platform;
  const result = {
    command: String(command || ""),
    cwd: String(options.cwd || ""),
    platform,
    dangerous: false,
    requiresApproval: false,
    severity: "safe",
    summary: GENERIC_SUMMARIES.safe,
    reasons: [],
    categories: [],
    matched: [],
    targets: [],
    safeTargets: [],
  };
  if (!flat) return result;

  // A pure inspection command cannot be destructive. Return immediately so a
  // read-only Get-Content / Get-ChildItem never waits for an approval popup.
  if (READ_ONLY_COMMAND.test(flat) && !WRITE_OR_EXEC_INTENT.test(flat)) {
    return result;
  }

  for (const rule of RULES) {
    if (!rule.pattern.test(flat)) continue;
    result.dangerous = true;
    result.severity = maxSeverity(result.severity, rule.severity);
    result.reasons.push(rule.reason);
    if (!result.categories.includes(rule.category)) result.categories.push(rule.category);
    result.matched.push(rule.id);
    if (result.summary === GENERIC_SUMMARIES.safe) result.summary = rule.summary;
  }

  const deletion = deletionAssessment(flat, options.cwd || "");
  if (deletion.destructive) {
    result.dangerous = true;
    result.targets = deletion.targets;
    result.severity = maxSeverity(result.severity, deletion.severity);
    for (const reason of deletion.reasons) result.reasons.push(reason);
    if (!result.categories.includes("File deletion")) result.categories.push("File deletion");
    result.matched.push(deletion.recursive ? "recursive-delete" : "wildcard-delete");
    if (result.summary === GENERIC_SUMMARIES.safe) {
      result.summary = deletion.recursive
        ? "Recursively deletes files from disk. This cannot be undone."
        : "Deletes multiple files with a wildcard. This cannot be undone.";
    }
    if (deletion.severity === "medium") {
      result.safeTargets = deletion.targets;
    }
  }

  if (!result.dangerous) {
    result.severity = "safe";
    return result;
  }

  // Deduplicate reasons while preserving order and keep the dialog readable.
  result.reasons = [...new Set(result.reasons)].slice(0, 6);
  result.summary = result.summary || GENERIC_SUMMARIES[result.severity];
  result.requiresApproval = SEVERITY_ORDER[result.severity] >= SEVERITY_ORDER.high;
  return result;
}

/** Short one-line description used in logs and the coding console. */
export function describeCommandRisk(assessment) {
  if (!assessment || !assessment.dangerous) return "safe";
  const categories = assessment.categories.length ? " (" + assessment.categories.join(", ") + ")" : "";
  return assessment.severity + categories + ": " + assessment.summary;
}
