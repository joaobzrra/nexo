const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("Claude Windows console bridge preserves status-line stdin and usage", {
  skip: process.platform !== "win32",
}, () => {
  const wrapper = path.resolve(__dirname, "..", "..", "spike", "collector", "claude-hook.cmd");
  const payload = JSON.stringify({
    session_id: "bridge-test",
    model: { display_name: "BRIDGE_OK" },
    context_window: {
      total_input_tokens: 250,
      context_window_size: 1000,
      used_percentage: 25,
    },
    cost: { total_cost_usd: 0.02 },
  });
  const result = spawnSync(wrapper, [], {
    input: payload,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: true,
    env: {
      ...process.env,
      AGENTTERMINAL_TELEMETRY_TOKEN: "",
      NEXO_EXECUTABLE: process.execPath,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /BRIDGE_OK/);
  assert.match(result.stdout, /ctx 25%/);
  assert.match(result.stdout, /\$0\.02/);
});

test("hook refuses to delegate to itself even with a poisoned state file", () => {
  // Regression: CLM-statusline-self-delegation-fork-bomb. A previousStatusLine
  // pointing back at claude-hook.mjs must be ignored, not spawned.
  const fs = require("node:fs");
  const os = require("node:os");
  const hook = path.resolve(__dirname, "..", "..", "spike", "collector", "claude-hook.mjs");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nexo-hook-guard-"));
  fs.writeFileSync(path.join(userData, "telemetry-integration.json"), JSON.stringify({
    claude: {
      previousStatusLine: { type: "command", command: `node "${hook}"` },
    },
  }));

  const started = Date.now();
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: "guard-test", model: { display_name: "GUARD_OK" } }),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...process.env,
      AGENTTERMINAL_TELEMETRY_TOKEN: "",
      NEXO_USER_DATA: userData,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /GUARD_OK/);
  // Without the guard the hook chains into itself and burns the full child
  // timeout per level; with it, the run is immediate.
  assert.ok(Date.now() - started < 5_000, `hook took ${Date.now() - started}ms`);
});
