import fs from "node:fs";
import path from "node:path";

const HEADER_CHUNK_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_TURN_CONTEXT_SCAN_BYTES = 8 * 1024 * 1024;
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function sessionIdFromFilename(file) {
  const basename = path.basename(file);
  return basename.match(UUID_AT_END)?.[1] ?? path.basename(file, ".jsonl");
}

export function metaFromSessionPayload(file, payload = {}) {
  return {
    sessionId:
      nonEmptyString(payload.id) ??
      nonEmptyString(payload.session_id) ??
      sessionIdFromFilename(file),
    identitySource:
      nonEmptyString(payload.id) || nonEmptyString(payload.session_id)
        ? "session_meta"
        : "filename",
    cwd: nonEmptyString(payload.cwd),
    cliVersion: nonEmptyString(payload.cli_version),
    originator: nonEmptyString(payload.originator),
    subagent:
      payload.thread_source === "subagent" ||
      payload.source === "subagent" ||
      Boolean(payload.source?.subagent),
  };
}

// Codex writes session_meta as the first JSONL record. Read that record
// independently from the bounded tail so collector restarts never lose the
// authoritative UUID or subagent classification for large live sessions.
export function readSessionMeta(file, maxBytes = MAX_HEADER_BYTES) {
  const fallback = metaFromSessionPayload(file);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    let total = 0;
    let newlineAt = -1;

    while (total < maxBytes && newlineAt < 0) {
      const size = Math.min(HEADER_CHUNK_BYTES, maxBytes - total);
      const chunk = Buffer.alloc(size);
      const read = fs.readSync(fd, chunk, 0, size, total);
      if (read <= 0) break;
      const actual = chunk.subarray(0, read);
      const localNewline = actual.indexOf(0x0a);
      if (localNewline >= 0) {
        chunks.push(actual.subarray(0, localNewline));
        newlineAt = total + localNewline;
      } else {
        chunks.push(actual);
      }
      total += read;
    }

    if (newlineAt < 0) return fallback;
    const first = Buffer.concat(chunks).toString("utf8").trim();
    const obj = JSON.parse(first);
    if (obj?.type !== "session_meta" || !obj.payload) return fallback;
    return metaFromSessionPayload(file, obj.payload);
  } catch {
    return fallback;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

export function readLatestTurnContext(file, maxBytes = MAX_TURN_CONTEXT_SCAN_BYTES) {
  try {
    const stat = fs.statSync(file);
    const from = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(stat.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    const lines = text.split("\n");
    if (from > 0) lines.shift();
    if (!text.endsWith("\n")) lines.pop();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes("\"turn_context\"")) continue;
      try {
        const obj = JSON.parse(lines[i]);
        if (obj?.type === "turn_context" && obj.payload) return obj;
      } catch {}
    }
  } catch {}
  return null;
}

export function readSessionSeed(file) {
  let meta = readSessionMeta(file);
  const turn = readLatestTurnContext(file);
  if (turn) ({ meta } = applyCodexLine(file, meta, turn));
  return meta;
}

export function normalizeRateLimits(payload = {}) {
  const rateLimits = [];
  for (const win of [payload.rate_limits?.primary, payload.rate_limits?.secondary]) {
    if (!win) continue;
    const mins = finiteOrNull(win.window_minutes);
    rateLimits.push({
      label:
        mins == null
          ? "plan"
          : mins >= 1440
            ? Math.round(mins / 1440) + "d"
            : Math.round(mins / 60) + "h",
      usedPercent: finiteOrNull(win.used_percent),
      windowMinutes: mins,
      resetsAt:
        finiteOrNull(win.resets_at) ?? nonEmptyString(win.resets_at),
    });
  }
  return rateLimits.length ? rateLimits : null;
}

export function applyCodexLine(file, previousMeta, obj) {
  let meta = previousMeta ?? metaFromSessionPayload(file);
  const payload = obj?.payload;
  if (!payload) return { meta, record: null };

  if (obj.type === "session_meta") {
    meta = { ...meta, ...metaFromSessionPayload(file, payload) };
    return { meta, record: null };
  }

  if (obj.type === "turn_context") {
    meta = {
      ...meta,
      model: nonEmptyString(payload.model) ?? meta.model,
      effort: nonEmptyString(payload.effort) ?? meta.effort,
      cwd: nonEmptyString(payload.cwd) ?? meta.cwd,
      approvalPolicy:
        nonEmptyString(payload.approval_policy) ?? meta.approvalPolicy,
    };
    return { meta, record: null };
  }

  if (obj.type === "event_msg" &&
      (payload.type === "task_started" || payload.type === "task_complete")) {
    return {
      meta,
      record: {
        source: "codex",
        sessionId: meta.sessionId,
        identitySource: meta.identitySource,
        subagent: meta.subagent ?? false,
        working: payload.type === "task_started",
        updatedAt: nonEmptyString(obj.timestamp),
        file: path.basename(file),
      },
    };
  }

  if (obj.type !== "event_msg" || payload.type !== "token_count") {
    return { meta, record: null };
  }

  const info = payload.info;
  const contextUsed = finiteOrNull(info?.last_token_usage?.total_tokens);
  const contextWindow = finiteOrNull(info?.model_context_window);
  const total = info?.total_token_usage;
  const schemaObserved = Boolean(info && contextUsed != null && contextWindow != null);

  return {
    meta,
    record: {
      source: "codex",
      sessionId: meta.sessionId,
      identitySource: meta.identitySource,
      cliVersion: meta.cliVersion ?? null,
      originator: meta.originator ?? null,
      model: meta.model ?? null,
      effort: meta.effort ?? null,
      cwd: meta.cwd ?? null,
      subagent: meta.subagent ?? false,
      contextUsed,
      contextWindow,
      contextLabel: schemaObserved ? "counted" : "unknown",
      schemaStatus: schemaObserved ? "observed" : "unknown",
      tokens: {
        input: finiteOrNull(total?.input_tokens),
        cachedInput: finiteOrNull(total?.cached_input_tokens),
        output: finiteOrNull(total?.output_tokens),
        reasoningOutput: finiteOrNull(total?.reasoning_output_tokens),
        total: finiteOrNull(total?.total_tokens),
      },
      costUsd: null,
      rateLimits: normalizeRateLimits(payload),
      updatedAt: nonEmptyString(obj.timestamp),
      file: path.basename(file),
    },
  };
}

// In hosted Codex loops, task_complete is emitted after individual tool
// steps as well as at the end of the visible turn. During live tailing, keep
// the pane working until the agent-turn-complete notifier supplies the
// authoritative false state. Replay still applies task_complete so a
// collector restart can seed an already-idle session correctly.
export function shouldUpsertCodexTailRecord(record, replay = false) {
  if (!record) return false;
  return replay || record.working !== false;
}

export function normalizeCodexBinding(payload = {}) {
  const sessionId =
    nonEmptyString(payload.sessionId) ?? nonEmptyString(payload["thread-id"]);
  const paneId =
    nonEmptyString(payload.paneId) ??
    (Number.isInteger(payload.paneId) ? String(payload.paneId) : null);
  if (!sessionId || !paneId) return null;

  const binding = {
    source: "codex",
    sessionId,
    paneId,
    paneBinding: "exact",
    // This endpoint is fed by Codex's agent-turn-complete notifier. Treat it
    // as a second authoritative completion signal if JSONL watching lags.
    working: false,
    updatedAt:
      nonEmptyString(payload.updatedAt) ?? new Date().toISOString(),
  };
  const cwd = nonEmptyString(payload.cwd);
  if (cwd) binding.cwd = cwd;
  return binding;
}
