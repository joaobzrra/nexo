// Nexo Claude Code statusline hook.
// This file is launched through claude-hook.cmd with Nexo.exe in Node mode.
// The console bridge is required on Windows because the packaged GUI process
// does not inherit Claude's JSON stdin reliably.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCommand(command, stdin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.stdin.end(stdin);
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve("");
    }, timeoutMs).unref();
  });
}

function integrationStateFile() {
  const userData = process.env.NEXO_USER_DATA ||
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Nexo");
  return path.join(userData, "telemetry-integration.json");
}

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  let p = {};
  try {
    p = JSON.parse(raw);
  } catch {}

  // AgentTerminal stamps each pane's env — the hook inherits it from claude,
  // giving the collector an exact pane <-> session link.
  const paneId = process.env.AGENTTERMINAL_PANE_ID ?? null;
  let body = raw;
  if (paneId != null && p && typeof p === "object") {
    body = JSON.stringify({ ...p, paneId });
  }

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(integrationStateFile(), "utf8"))?.claude?.previousStatusLine;
  } catch {}
  // Never delegate to another Nexo hook (that is this hook — a poisoned state
  // file otherwise fork-bombs the PC), and never delegate when this process is
  // already inside a delegation chain (CLM-statusline-self-delegation-fork-bomb).
  const selfDelegation = /claude-hook\.(cmd|mjs)|--telemetry-hook/i;
  const previousCommand = previous?.type === "command" && previous.command ? String(previous.command) : "";
  let previousOutput = "";
  if (previousCommand && !selfDelegation.test(previousCommand) && !process.env.NEXO_CLAUDE_HOOK_ACTIVE) {
    process.env.NEXO_CLAUDE_HOOK_ACTIVE = "1";
    previousOutput = await runCommand(previousCommand, raw);
  }

  // Forward to the authenticated loopback collector; never retain raw input.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 300);
    await fetch("http://127.0.0.1:4317/ingest/claude", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.AGENTTERMINAL_TELEMETRY_TOKEN || ""}`,
      },
      body,
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(t);
  } catch {}

  const model = p?.model?.display_name ?? p?.model?.id ?? "claude";
  const ctxPct = p?.context_window?.used_percentage;
  const ctx = ctxPct != null ? ` · ctx ${Math.round(ctxPct)}%` : "";
  const w5 = p?.rate_limits?.five_hour?.used_percentage;
  const w7 = p?.rate_limits?.seven_day?.used_percentage;
  const plan =
    (w5 != null ? ` · 5h ${Math.round(w5)}%` : "") +
    (w7 != null ? ` · 7d ${Math.round(w7)}%` : "");
  const cost = p?.cost?.total_cost_usd != null ? ` · $${p.cost.total_cost_usd.toFixed(2)}` : "";
  process.stdout.write(previousOutput || `${model}${ctx}${plan}${cost}`);
  process.exit(0);
});
