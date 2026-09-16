import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCodexLine,
  normalizeCodexBinding,
  readSessionMeta,
  readSessionSeed,
  sessionIdFromFilename,
  shouldUpsertCodexTailRecord,
} from "./codex-telemetry.mjs";
import { notificationToBinding, runDelegate } from "./codex-notify.mjs";

const ROOT_ID = "01a00118-6651-79b3-a7b0-2267db1800f9";
const SUBAGENT_ID = "01a00118-675d-7723-875f-fc23d0b0d6fa";

function withTempFile(id, threadSource, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentterminal-telemetry-"));
  const file = path.join(dir, "rollout-2026-08-14T13-26-11-" + id + ".jsonl");
  const meta = {
    timestamp: "2026-08-14T16:26:11.000Z",
    type: "session_meta",
    payload: {
      id,
      cwd: "E:\\Projects\\AgentTerminal",
      cli_version: "0.147.0",
      originator: "codex-tui",
      source: "cli",
      thread_source: threadSource,
    },
  };
  const filler = {
    timestamp: "2026-08-14T16:27:00.000Z",
    type: "response_item",
    payload: { opaque: "x".repeat(600 * 1024) },
  };
  fs.writeFileSync(
    file,
    JSON.stringify(meta) + "\n" +
      JSON.stringify(turnContext()) + "\n" +
      JSON.stringify(filler) + "\n"
  );
  try {
    run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function turnContext() {
  return {
    timestamp: "2026-08-14T18:40:00.000Z",
    type: "turn_context",
    payload: {
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "E:\\Projects\\AgentTerminal",
      approval_policy: "on-request",
    },
  };
}

function tokenCount(contextUsed, cumulative = 9060890) {
  return {
    timestamp: "2026-08-14T18:41:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: 258400,
        last_token_usage: { total_tokens: contextUsed },
        total_token_usage: {
          input_tokens: cumulative - 42000,
          cached_input_tokens: cumulative - 500000,
          output_tokens: 42000,
          reasoning_output_tokens: 21000,
          total_tokens: cumulative,
        },
      },
      rate_limits: {
        primary: {
          used_percent: 25,
          window_minutes: 10080,
          resets_at: 1787257172,
        },
      },
    },
  };
}

function taskState(type) {
  return {
    timestamp: type === "task_started"
      ? "2026-08-14T18:40:30.000Z"
      : "2026-08-14T18:41:30.000Z",
    type: "event_msg",
    payload: { type },
  };
}

test("recovers authoritative metadata before tailing a file larger than 512 KB", () => {
  withTempFile(SUBAGENT_ID, "subagent", (file) => {
    const meta = readSessionSeed(file);
    assert.equal(meta.sessionId, SUBAGENT_ID);
    assert.equal(meta.identitySource, "session_meta");
    assert.equal(meta.subagent, true);
    assert.equal(meta.cliVersion, "0.147.0");
    assert.equal(meta.model, "gpt-5.6-sol");
    assert.equal(meta.effort, "high");
  });
});

test("extracts the UUID instead of using the full rollout filename", () => {
  const file = "rollout-2026-08-14T13-26-11-" + ROOT_ID + ".jsonl";
  assert.equal(sessionIdFromFilename(file), ROOT_ID);
});

test("normalizes current context separately from cumulative token usage", () => {
  withTempFile(ROOT_ID, "user", (file) => {
    let meta = readSessionMeta(file);
    ({ meta } = applyCodexLine(file, meta, turnContext()));
    const first = applyCodexLine(file, meta, tokenCount(226223));
    assert.equal(first.record.model, "gpt-5.6-sol");
    assert.equal(first.record.effort, "high");
    assert.equal(first.record.contextUsed, 226223);
    assert.equal(first.record.contextWindow, 258400);
    assert.equal(first.record.tokens.total, 9060890);
    assert.equal(first.record.tokens.reasoningOutput, 21000);
    assert.equal(first.record.rateLimits[0].label, "7d");
    assert.equal(first.record.contextLabel, "counted");

    const compacted = applyCodexLine(file, first.meta, tokenCount(21633));
    assert.equal(compacted.record.contextUsed, 21633);
    assert.equal(compacted.record.tokens.total, 9060890);
  });
});

test("degrades an unrecognized token_count shape to unknown", () => {
  const file = "rollout-2026-08-14T13-26-11-" + ROOT_ID + ".jsonl";
  const result = applyCodexLine(file, null, {
    timestamp: "2026-08-14T18:41:00.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { future_shape: true } },
  });
  assert.equal(result.record.contextLabel, "unknown");
  assert.equal(result.record.schemaStatus, "unknown");
  assert.equal(result.record.contextUsed, null);
});

test("normalizes Codex task lifecycle as explicit working state", () => {
  const file = "rollout-2026-08-14T13-26-11-" + ROOT_ID + ".jsonl";
  const started = applyCodexLine(file, null, taskState("task_started"));
  assert.equal(started.record.source, "codex");
  assert.equal(started.record.sessionId, ROOT_ID);
  assert.equal(started.record.working, true);
  assert.equal(started.record.updatedAt, "2026-08-14T18:40:30.000Z");

  const complete = applyCodexLine(file, started.meta, taskState("task_complete"));
  assert.equal(complete.record.working, false);
  assert.equal(complete.record.updatedAt, "2026-08-14T18:41:30.000Z");
  assert.equal(shouldUpsertCodexTailRecord(started.record), true);
  assert.equal(shouldUpsertCodexTailRecord(complete.record), false);
  assert.equal(shouldUpsertCodexTailRecord(complete.record, true), true);
});

test("creates a privacy-minimal exact pane binding from Codex notify", () => {
  const binding = notificationToBinding(
    {
      type: "agent-turn-complete",
      "thread-id": ROOT_ID,
      "turn-id": "turn-secret-not-forwarded",
      cwd: "E:\\Projects\\AgentTerminal",
      "input-messages": ["private prompt"],
      "last-assistant-message": "private response",
    },
    { AGENTTERMINAL_PANE_ID: "7" },
    () => new Date("2026-08-14T18:42:00.000Z")
  );
  assert.deepEqual(binding, {
    source: "codex",
    sessionId: ROOT_ID,
    paneId: "7",
    paneBinding: "exact",
    working: false,
    cwd: "E:\\Projects\\AgentTerminal",
    updatedAt: "2026-08-14T18:42:00.000Z",
  });
  assert.equal(JSON.stringify(binding).includes("private"), false);
});

test("does not create pane bindings outside AgentTerminal", () => {
  assert.equal(
    notificationToBinding({ type: "agent-turn-complete", "thread-id": ROOT_ID }, {}),
    null
  );
  assert.equal(normalizeCodexBinding({ sessionId: ROOT_ID }), null);
  const binding = normalizeCodexBinding({ sessionId: ROOT_ID, paneId: "3" });
  assert.equal(Object.hasOwn(binding, "cwd"), false);
});

test("passes the original payload through to an existing notify command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentterminal-notify-"));
  const marker = path.join(dir, "delegate-payload.json");
  const rawPayload = JSON.stringify({ type: "agent-turn-complete", "thread-id": ROOT_ID });
  try {
    await runDelegate([
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
      marker,
    ], rawPayload);
    assert.equal(fs.readFileSync(marker, "utf8"), rawPayload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
