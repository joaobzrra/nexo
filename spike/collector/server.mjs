// AgentTerminal Horizon-1 spike — telemetry collector.
// Zero dependencies. Node 18+.
//
//   node server.mjs --token <random> [--state-file <path>]
//                   [--port 4317] [--codex-dir <dir>]
//
// Ingests:
//   - Claude Code statusline payloads   POST /ingest/claude   (from claude-hook.mjs)
//   - Codex session JSONL               tailed from ~/.codex/sessions (read-only)
//   - Synthetic test payloads           POST /ingest/test     (normalized shape)
// Serves:
//   - GET /         viewer page
//   - GET /events   SSE stream of normalized telemetry
//   - GET /state    current snapshot (JSON)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applyCodexLine,
  normalizeCodexBinding,
  readSessionSeed,
  shouldUpsertCodexTailRecord,
} from "./codex-telemetry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = Number(argOf("--port", "4317"));
const CODEX_DIR = argOf("--codex-dir", path.join(os.homedir(), ".codex", "sessions"));
const VIEWER = path.join(__dirname, "..", "viewer", "index.html");
const TOKEN = argOf("--token", "");
const STATE_FILE = argOf("--state-file", "");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

if (!TOKEN) throw new Error("--token is required; unauthenticated telemetry is disabled");

// ---------------------------------------------------------------- state ----
// sessions: id -> normalized telemetry record
const sessions = new Map();
const sseClients = new Set();
let persistTimer = null;

const PERSISTED_FIELDS = [
  "source", "sessionId", "sessionName", "paneId", "model", "effort", "cwd",
  "contextUsed", "contextWindow", "contextPercent", "contextLabel", "tokens",
  "costUsd", "rateLimits", "working", "updatedAt",
];

function persistedRecord(rec) {
  const clean = {};
  for (const key of PERSISTED_FIELDS) {
    if (rec[key] !== undefined) clean[key] = rec[key];
  }
  return clean;
}

function pruneExpired() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, rec] of sessions) {
    const timestamp = Date.parse(rec.updatedAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) sessions.delete(id);
  }
}

function persistState() {
  persistTimer = null;
  if (!STATE_FILE) return;
  pruneExpired();
  const dir = path.dirname(STATE_FILE);
  const temp = STATE_FILE + ".tmp";
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify([...sessions.values()].map(persistedRecord)), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, STATE_FILE);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    console.error("telemetry state write failed:", error.message);
  }
}

function schedulePersist() {
  if (!STATE_FILE || persistTimer) return;
  persistTimer = setTimeout(persistState, 250);
}

function loadState() {
  if (!STATE_FILE) return;
  try {
    const records = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(records)) return;
    for (const rec of records) {
      if (rec && typeof rec.sessionId === "string") sessions.set(rec.sessionId, persistedRecord(rec));
    }
    pruneExpired();
  } catch (error) {
    if (error.code !== "ENOENT") console.error("telemetry state read failed:", error.message);
  }
}

loadState();

function upsert(rec) {
  if (!rec || typeof rec.sessionId !== "string") return;
  // The allowlist is the data boundary, not just a disk serialization detail:
  // disallowed fields never enter memory, SSE responses, or persisted state.
  rec = persistedRecord(rec);
  const prev = sessions.get(rec.sessionId) ?? {};
  // Prefer the event's own timestamp: re-tailing an old file on restart must
  // not make a dead session look freshly active.
  const candidate = rec.updatedAt ?? new Date().toISOString();
  const previousTime = Date.parse(prev.updatedAt);
  const candidateTime = Date.parse(candidate);
  const updatedAt =
    Number.isFinite(previousTime) &&
    Number.isFinite(candidateTime) &&
    previousTime > candidateTime
      ? prev.updatedAt
      : candidate;
  const merged = { ...prev, ...rec, updatedAt };
  sessions.set(rec.sessionId, merged);
  broadcast(merged);
  schedulePersist();
}

function broadcast(rec) {
  const line = `data: ${JSON.stringify(rec)}\n\n`;
  for (const res of sseClients) res.write(line);
}

// ------------------------------------------------- claude normalization ----
// Field mapping verified against real captured payloads (Claude Code 2.1.232,
// see captured-claude-payloads.jsonl). Anything missing is reported as null
// and labeled accordingly — honest telemetry, no guessing.
function normalizeClaude(p) {
  const cw = p?.context_window ?? {};
  const ctxWindow = cw.context_window_size ?? null;
  const ctxUsed = cw.total_input_tokens ?? null;
  const rl = p?.rate_limits ?? {};
  const rateLimits = [];
  if (rl.five_hour) {
    rateLimits.push({
      label: "5h",
      usedPercent: rl.five_hour.used_percentage ?? null,
      windowMinutes: 300,
      resetsAt: rl.five_hour.resets_at ?? null, // unix seconds
    });
  }
  if (rl.seven_day) {
    rateLimits.push({
      label: "7d",
      usedPercent: rl.seven_day.used_percentage ?? null,
      windowMinutes: 10080,
      resetsAt: rl.seven_day.resets_at ?? null,
    });
  }
  return {
    source: "claude",
    sessionId: p?.session_id ?? "claude-unknown",
    sessionName: p?.session_name ?? null,
    paneId: p?.paneId ?? null,
    model: p?.model?.display_name ?? p?.model?.id ?? null,
    effort: p?.effort?.level ?? null,
    cwd: p?.workspace?.current_dir ?? p?.cwd ?? null,
    contextUsed: ctxUsed,
    contextWindow: ctxWindow,
    // Claude Code computes this itself; prefer it over our own division.
    contextPercent: cw.used_percentage ?? null,
    contextLabel: ctxUsed != null && ctxWindow != null ? "measured" : "unknown",
    tokens: {
      input: cw.total_input_tokens ?? null,
      output: cw.total_output_tokens ?? null,
      cachedInput: cw.current_usage?.cache_read_input_tokens ?? null,
    },
    costUsd: p?.cost?.total_cost_usd ?? null,
    rateLimits: rateLimits.length ? rateLimits : null,
  };
}

// -------------------------------------------------- codex JSONL tailing ----
const offsets = new Map(); // file -> byte offset
const fileMeta = new Map(); // file -> normalized session metadata

function tailFile(file, replay = false) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  const firstSight = !offsets.has(file);
  if (firstSight) fileMeta.set(file, readSessionSeed(file));
  const from = firstSight ? Math.max(0, stat.size - 512 * 1024) : offsets.get(file); // first sight: last 512KB
  if (stat.size <= from) return;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(stat.size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  offsets.set(file, stat.size);
  const text = buf.toString("utf8");
  // drop a possibly-partial first line on first sight, and partial last line
  const lines = text.split("\n");
  if (firstSight && from > 0) lines.shift();
  if (!text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    handleCodexLine(file, obj, replay);
  }
}

function handleCodexLine(file, obj, replay = false) {
  const result = applyCodexLine(file, fileMeta.get(file), obj);
  fileMeta.set(file, result.meta);
  if (shouldUpsertCodexTailRecord(result.record, replay)) upsert(result.record);
}

function scanCodexDir(replay = false) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(CODEX_DIR, 0);
  // only tail files touched in the last 24h to keep it cheap
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of files) {
    try {
      if (fs.statSync(f).mtimeMs >= cutoff) tailFile(f, replay);
    } catch {}
  }
}

// fs.watch recursive is supported on Windows; poll as a fallback safety net.
try {
  fs.watch(CODEX_DIR, { recursive: true }, (_ev, name) => {
    if (name && name.endsWith(".jsonl")) tailFile(path.join(CODEX_DIR, name), false);
  });
} catch (e) {
  console.error("fs.watch failed, relying on poll:", e.message);
}
setInterval(() => scanCodexDir(false), 5000);
// Only the startup scan is replay. Files first observed after this point are
// live even though their byte offset has not been initialized yet.
scanCodexDir(true);

// ----------------------------------------------------------- http server ----
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        rejected = true;
        reject(new Error("request body exceeds " + maxBytes + " bytes"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : "";
  const candidate = bearer || url.searchParams.get("token") || "";
  const expectedBytes = Buffer.from(TOKEN);
  const candidateBytes = Buffer.from(candidate);
  const authorized = candidateBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(candidateBytes, expectedBytes);
  if (!authorized) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(VIEWER));
    return;
  }
  if (req.method === "GET" && url.pathname === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([...sessions.values()]));
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const rec of sessions.values()) res.write(`data: ${JSON.stringify(rec)}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname === "/ingest/claude") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      upsert({ ...normalizeClaude(payload), updatedAt: new Date().toISOString() });
      res.writeHead(204).end();
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/ingest/test") {
    try {
      const body = await readBody(req);
      upsert(JSON.parse(body));
      res.writeHead(204).end();
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/ingest/codex-pane") {
    try {
      const payload = JSON.parse(await readBody(req));
      const binding = normalizeCodexBinding(payload);
      if (!binding) throw new Error("sessionId and paneId are required");
      upsert(binding);
      res.writeHead(204).end();
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`collector on authenticated loopback port ${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistState();
    server.close(() => process.exit(0));
  });
}
