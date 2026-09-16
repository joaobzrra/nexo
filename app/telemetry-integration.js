const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_VERSION = 1;

function integrationPaths({ userData, home = os.homedir() }) {
  return {
    stateFile: path.join(userData, "telemetry-integration.json"),
    telemetryFile: path.join(userData, "telemetry-state.json"),
    backupDir: path.join(userData, "telemetry-backups"),
    claudeFile: path.join(home, ".claude", "settings.json"),
    codexFile: path.join(home, ".codex", "config.toml"),
    updaterCache: path.join(process.env.LOCALAPPDATA || path.dirname(userData), "nexo-updater"),
  };
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readState(paths) {
  const raw = readText(paths.stateFile);
  if (!raw) return { version: STATE_VERSION, prompted: false, enabled: false };
  try { return JSON.parse(raw); } catch {
    return { version: STATE_VERSION, prompted: false, enabled: false, stateError: true };
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function backupFile(file, backupDir, label) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backupDir, `${stamp}-${label}`);
  fs.copyFileSync(file, backup);
  return backup;
}

function restoreSnapshot(file, content) {
  if (content == null) {
    try { fs.rmSync(file, { force: true }); } catch {}
  } else atomicWrite(file, content);
}

function quoteCommand(file, args = []) {
  const quote = (value) => `"${String(value).replace(/"/g, '\"')}"`;
  return [quote(file), ...args.map(quote)].join(" ");
}

function parseTomlStringArray(raw) {
  let i = 0;
  const values = [];
  const backslash = String.fromCharCode(92);
  const skip = () => { while (/\s/.test(raw[i] || "")) i += 1; };
  skip();
  if (raw[i++] !== "[") throw new Error("Codex notify must be a TOML string array");
  while (i < raw.length) {
    skip();
    if (raw[i] === "]") return values;
    const quote = raw[i++];
    if (quote !== '"' && quote !== "'") throw new Error("Codex notify contains a non-string value");
    let value = "";
    let closed = false;
    while (i < raw.length) {
      const char = raw[i++];
      if (char === quote) {
        if (quote === "'" && raw[i] === "'") { value += "'"; i += 1; continue; }
        closed = true;
        break;
      }
      if (quote === '"' && char === backslash) {
        const escaped = raw[i++];
        const map = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', [backslash]: backslash };
        value += map[escaped] ?? escaped;
      } else value += char;
    }
    if (!closed) throw new Error("Codex notify has an unterminated string");
    values.push(value);
    skip();
    if (raw[i] === ",") { i += 1; continue; }
    if (raw[i] === "]") return values;
    throw new Error("Codex notify array is malformed");
  }
  throw new Error("Codex notify array is unterminated");
}

function findNotifyAssignment(content) {
  const match = /^\s*notify\s*=\s*/m.exec(content);
  if (!match) return null;
  const start = match.index;
  const valueStart = match.index + match[0].length;
  let i = valueStart;
  while (/\s/.test(content[i] || "")) i += 1;
  if (content[i] !== "[") throw new Error("Codex notify is not an array");
  let depth = 0;
  let quote = null;
  let escaped = false;
  const backslash = String.fromCharCode(92);
  for (; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (quote === '"' && char === backslash) escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const end = i + 1;
        return {
          start,
          end,
          raw: content.slice(start, end),
          valueRaw: content.slice(valueStart, end).trim(),
          values: parseTomlStringArray(content.slice(valueStart, end).trim()),
        };
      }
    }
  }
  throw new Error("Codex notify array is unterminated");
}

function tomlArray(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(", ")}]`;
}

function replaceNotify(content, assignment) {
  const current = findNotifyAssignment(content);
  if (current) return content.slice(0, current.start) + assignment + content.slice(current.end);
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${assignment}\n`;
}

function removeNotify(content) {
  const current = findNotifyAssignment(content);
  if (!current) return content;
  let end = current.end;
  if (content[end] === "\r" && content[end + 1] === "\n") end += 2;
  else if (content[end] === "\n") end += 1;
  return content.slice(0, current.start) + content.slice(end);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A "previous" hook that is itself one of Nexo's hooks (any version, any
// install path) must never be recorded or restored for delegation: the hook
// would delegate to itself and fork-bomb the machine with orphaned processes
// (CLM-statusline-self-delegation-fork-bomb, 2026-08-15).
const NEXO_OWNED_HOOK = /claude-hook\.(cmd|mjs)|--telemetry-hook/i;

function isNexoOwnedStatusLine(statusLine) {
  return Boolean(
    statusLine &&
    statusLine.type === "command" &&
    NEXO_OWNED_HOOK.test(String(statusLine.command ?? ""))
  );
}

function sanitizePreviousStatusLine(statusLine) {
  return isNexoOwnedStatusLine(statusLine) ? null : statusLine ?? null;
}

function integrationStatus(options) {
  const paths = integrationPaths(options);
  const state = readState(paths);
  return {
    prompted: Boolean(state.prompted),
    enabled: Boolean(state.enabled),
    stateError: Boolean(state.stateError),
    claudeFile: paths.claudeFile,
    codexFile: paths.codexFile,
    backupDir: paths.backupDir,
  };
}

function markPrompted(options) {
  const paths = integrationPaths(options);
  const state = { ...readState(paths), version: STATE_VERSION, prompted: true };
  atomicWrite(paths.stateFile, JSON.stringify(state, null, 2));
  return integrationStatus(options);
}

function enableIntegration({
  userData,
  home = os.homedir(),
  executable = process.execPath,
  claudeHook = null,
}) {
  const options = { userData, home };
  const paths = integrationPaths(options);
  const oldState = readState(paths);
  const claudeRaw = readText(paths.claudeFile);
  const codexRaw = readText(paths.codexFile);
  const claudeSettings = claudeRaw == null ? {} : JSON.parse(claudeRaw);
  const codexContent = codexRaw ?? "";
  const currentNotify = findNotifyAssignment(codexContent);
  const repairingClaude = Boolean(
    oldState.enabled &&
    sameJson(claudeSettings.statusLine, oldState.claude?.installedStatusLine)
  );
  const repairingCodex = Boolean(
    oldState.enabled &&
    currentNotify &&
    sameJson(currentNotify.values, oldState.codex?.installedValues)
  );
  const previousNotify = repairingCodex
    ? (oldState.codex?.previousAssignment
      ? findNotifyAssignment(oldState.codex.previousAssignment)
      : null)
    : currentNotify;
  const installedStatusLine = {
    type: "command",
    command: claudeHook
      ? quoteCommand(claudeHook)
      : quoteCommand(executable, ["--telemetry-hook=claude"]),
  };
  const notifyValues = [executable, "--telemetry-hook=codex"];
  if (previousNotify && !previousNotify.values.some((value) => NEXO_OWNED_HOOK.test(String(value)))) {
    notifyValues.push("--delegate", ...previousNotify.values);
  }
  const installedNotify = `notify = ${tomlArray(notifyValues)}`;
  const claudeBackup = repairingClaude
    ? oldState.claude?.backup ?? null
    : backupFile(paths.claudeFile, paths.backupDir, "claude-settings.json");
  const codexBackup = repairingCodex
    ? oldState.codex?.backup ?? null
    : backupFile(paths.codexFile, paths.backupDir, "codex-config.toml");
  const nextClaude = { ...claudeSettings, statusLine: installedStatusLine };
  const nextCodex = replaceNotify(codexContent, installedNotify);

  try {
    atomicWrite(paths.claudeFile, JSON.stringify(nextClaude, null, 2) + "\n");
    atomicWrite(paths.codexFile, nextCodex);
  } catch (error) {
    restoreSnapshot(paths.claudeFile, claudeRaw);
    restoreSnapshot(paths.codexFile, codexRaw);
    throw error;
  }

  const state = {
    ...oldState,
    version: STATE_VERSION,
    prompted: true,
    enabled: true,
    installedAt: new Date().toISOString(),
    executable,
    claude: {
      backup: claudeBackup,
      previousStatusLine: sanitizePreviousStatusLine(
        repairingClaude ? oldState.claude?.previousStatusLine : claudeSettings.statusLine
      ),
      installedStatusLine,
    },
    codex: {
      backup: codexBackup,
      previousAssignment: previousNotify?.raw ?? null,
      installedAssignment: installedNotify,
      installedValues: notifyValues,
    },
  };
  try {
    atomicWrite(paths.stateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    restoreSnapshot(paths.claudeFile, claudeRaw);
    restoreSnapshot(paths.codexFile, codexRaw);
    throw error;
  }
  return integrationStatus(options);
}

function repairOwnedIntegration({
  userData,
  home = os.homedir(),
  executable = process.execPath,
  claudeHook = null,
}) {
  const options = { userData, home };
  const paths = integrationPaths(options);
  const state = readState(paths);
  if (!state.enabled) return { ...integrationStatus(options), repaired: false, reason: "disabled" };

  const claudeRaw = readText(paths.claudeFile);
  const codexRaw = readText(paths.codexFile);
  const claudeSettings = claudeRaw == null ? {} : JSON.parse(claudeRaw);
  const currentNotify = findNotifyAssignment(codexRaw ?? "");
  const ownsClaude = Boolean(
    state.claude?.installedStatusLine &&
    sameJson(claudeSettings.statusLine, state.claude.installedStatusLine)
  );
  const ownsCodex = Boolean(
    state.codex?.installedValues &&
    currentNotify &&
    sameJson(currentNotify.values, state.codex.installedValues)
  );

  // Automatic launch-time repair is deliberately conservative. If either
  // hook changed after consent, preserve both and leave manual Repair to the
  // user instead of silently reclaiming configuration ownership.
  if (!ownsClaude || !ownsCodex) {
    return { ...integrationStatus(options), repaired: false, reason: "hook-changed" };
  }

  return {
    ...enableIntegration({ userData, home, executable, claudeHook }),
    repaired: true,
    reason: "owned-hooks-refreshed",
  };
}

function disableIntegration({ userData, home = os.homedir(), deleteData = false }) {
  const options = { userData, home };
  const paths = integrationPaths(options);
  const state = readState(paths);
  const result = { claude: "not-configured", codex: "not-configured" };

  if (state.claude) {
    const raw = readText(paths.claudeFile);
    if (raw != null) {
      const settings = JSON.parse(raw);
      if (sameJson(settings.statusLine, state.claude.installedStatusLine)) {
        const restoredStatusLine = sanitizePreviousStatusLine(state.claude.previousStatusLine);
        if (restoredStatusLine == null) delete settings.statusLine;
        else settings.statusLine = restoredStatusLine;
        atomicWrite(paths.claudeFile, JSON.stringify(settings, null, 2) + "\n");
        result.claude = "restored";
      } else result.claude = "preserved-user-change";
    } else result.claude = "preserved-user-change";
  }

  if (state.codex) {
    const content = readText(paths.codexFile) ?? "";
    const current = findNotifyAssignment(content);
    if (current && sameJson(current.values, state.codex.installedValues)) {
      const restored = state.codex.previousAssignment
        ? replaceNotify(content, state.codex.previousAssignment)
        : removeNotify(content);
      atomicWrite(paths.codexFile, restored);
      result.codex = "restored";
    } else result.codex = "preserved-user-change";
  }

  const nextState = { ...state, version: STATE_VERSION, prompted: true, enabled: false, disabledAt: new Date().toISOString() };
  atomicWrite(paths.stateFile, JSON.stringify(nextState, null, 2));
  if (deleteData) {
    for (const target of [paths.telemetryFile, paths.updaterCache]) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
    const safeToRemoveNexoState = Object.values(result).every(
      (value) => value === "restored" || value === "not-configured"
    );
    if (safeToRemoveNexoState) {
      for (const target of [paths.backupDir, paths.stateFile]) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      }
    }
  }
  return {
    ...result,
    removedNexoState: deleteData && !fs.existsSync(paths.stateFile),
    status: integrationStatus(options),
  };
}

module.exports = {
  disableIntegration,
  enableIntegration,
  findNotifyAssignment,
  isNexoOwnedStatusLine,
  integrationPaths,
  integrationStatus,
  markPrompted,
  parseTomlStringArray,
  quoteCommand,
  repairOwnedIntegration,
  replaceNotify,
  tomlArray,
};
