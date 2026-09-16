const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.resume();
  });
}

async function postLocal(pathname, body) {
  const token = process.env.AGENTTERMINAL_TELEMETRY_TOKEN || "";
  if (!token) return false;
  const port = Number(process.env.AGENTTERMINAL_TELEMETRY_PORT || 4317);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch { return false; }
}

function runCommand(command, stdin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch { resolve(""); return; }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.stdin.end(stdin);
    setTimeout(() => { try { child.kill(); } catch {} resolve(""); }, timeoutMs).unref();
  });
}

function runDelegate(args, payload) {
  if (!args.length) return Promise.resolve();
  const [command, ...rest] = args;
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, [...rest, payload], { windowsHide: true, stdio: "ignore" }); }
    catch { resolve(); return; }
    child.on("error", resolve);
    child.on("exit", resolve);
    setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 10000).unref();
  });
}

// Never delegate to another Nexo hook or from inside an existing delegation
// chain — a poisoned previousStatusLine otherwise makes the hook spawn itself
// forever (CLM-statusline-self-delegation-fork-bomb).
const NEXO_OWNED_HOOK = /claude-hook\.(cmd|mjs)|--telemetry-hook/i;

function claudeLine(payload) {
  const model = payload?.model?.display_name ?? payload?.model?.id ?? "claude";
  const context = payload?.context_window?.used_percentage;
  const five = payload?.rate_limits?.five_hour?.used_percentage;
  const seven = payload?.rate_limits?.seven_day?.used_percentage;
  return model +
    (context != null ? ` · ctx ${Math.round(context)}%` : "") +
    (five != null ? ` · 5h ${Math.round(five)}%` : "") +
    (seven != null ? ` · 7d ${Math.round(seven)}%` : "");
}

async function runClaudeHook(userData) {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch {}
  if (process.env.AGENTTERMINAL_PANE_ID) payload.paneId = process.env.AGENTTERMINAL_PANE_ID;
  const stateFile = path.join(userData, "telemetry-integration.json");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stateFile, "utf8"))?.claude?.previousStatusLine; } catch {}
  const previousCommand = previous?.type === "command" && previous.command ? String(previous.command) : "";
  let previousOutput = "";
  if (previousCommand && !NEXO_OWNED_HOOK.test(previousCommand) && !process.env.NEXO_CLAUDE_HOOK_ACTIVE) {
    process.env.NEXO_CLAUDE_HOOK_ACTIVE = "1";
    previousOutput = await runCommand(previousCommand, raw);
  }
  await postLocal("/ingest/claude", JSON.stringify(payload));
  process.stdout.write(previousOutput || claudeLine(payload));
}

async function runCodexHook(args) {
  const raw = args.at(-1) || "";
  const delegateAt = args.indexOf("--delegate");
  let delegate = delegateAt >= 0 ? args.slice(delegateAt + 1, -1) : [];
  if (delegate.some((value) => NEXO_OWNED_HOOK.test(String(value)))) delegate = [];
  let notification = null;
  try { notification = JSON.parse(raw); } catch {}
  const binding = notification?.type === "agent-turn-complete"
    ? {
        sessionId: notification["thread-id"],
        paneId: process.env.AGENTTERMINAL_PANE_ID,
        cwd: notification.cwd,
        updatedAt: new Date().toISOString(),
      }
    : null;
  await Promise.allSettled([
    binding ? postLocal("/ingest/codex-pane", JSON.stringify(binding)) : Promise.resolve(false),
    runDelegate(delegate, raw),
  ]);
}

async function runTelemetryHook(kind, userData, args) {
  if (kind === "claude") return runClaudeHook(userData);
  if (kind === "codex") return runCodexHook(args);
  throw new Error(`Unknown telemetry hook: ${kind}`);
}

module.exports = { claudeLine, postLocal, runTelemetryHook };
