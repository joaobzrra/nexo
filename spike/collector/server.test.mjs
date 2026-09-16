import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

async function waitFor(url, token) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("collector did not start");
}

test("collector requires authentication and never retains non-allowlisted payload fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexo-collector-"));
  const stateFile = path.join(root, "state.json");
  const codexDir = path.join(root, "empty-sessions");
  fs.mkdirSync(codexDir, { recursive: true });
  const port = 24000 + Math.floor(Math.random() * 12000);
  const token = "test-token-" + Math.random().toString(36).slice(2);
  const child = spawn(process.execPath, [
    path.join(here, "server.mjs"),
    "--port", String(port),
    "--token", token,
    "--state-file", stateFile,
    "--codex-dir", codexDir,
  ], { stdio: "ignore", windowsHide: true });
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitFor(`${base}/state`, token);
    assert.equal((await fetch(`${base}/state`)).status, 401);
    assert.equal((await fetch(`${base}/state?token=wrong`)).status, 401);
    const ingest = await fetch(`${base}/ingest/test`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: "session-1",
        source: "test",
        model: "local",
        updatedAt: new Date().toISOString(),
        prompt: "must never be retained",
        transcript: ["private"],
      }),
    });
    assert.equal(ingest.status, 204);
    const state = await (await fetch(`${base}/state`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.equal(state.length, 1);
    assert.equal(state[0].model, "local");
    assert.equal("prompt" in state[0], false);
    assert.equal("transcript" in state[0], false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const persisted = fs.readFileSync(stateFile, "utf8");
    assert.doesNotMatch(persisted, /must never|private/);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
