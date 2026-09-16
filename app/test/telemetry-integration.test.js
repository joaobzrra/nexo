const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  disableIntegration,
  enableIntegration,
  findNotifyAssignment,
  integrationPaths,
  repairOwnedIntegration,
} = require("../telemetry-integration");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexo-integration-"));
  const home = path.join(root, "home");
  const userData = path.join(root, "data");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return { root, home, userData, paths: integrationPaths({ userData, home }) };
}

test("enable wraps existing hooks and creates exact backups", () => {
  const f = fixture();
  const previousStatusLine = { type: "command", command: "existing-claude --status" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ theme: "dark", statusLine: previousStatusLine }, null, 2));
  fs.writeFileSync(f.paths.codexFile, 'model = "gpt"\nnotify = ["existing.exe", "turn-ended"]\n');

  const status = enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  assert.equal(status.enabled, true);
  const claude = JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8"));
  assert.match(claude.statusLine.command, /Nexo\.exe/);
  const notify = findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8"));
  assert.deepEqual(notify.values, ["C:\\Apps\\Nexo.exe", "--telemetry-hook=codex", "--delegate", "existing.exe", "turn-ended"]);
  const state = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  assert.equal(fs.existsSync(state.claude.backup), true);
  assert.equal(fs.existsSync(state.codex.backup), true);
  assert.deepEqual(state.claude.previousStatusLine, previousStatusLine);
});

test("disable restores previous hooks without deleting native config", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ statusLine: { type: "command", command: "old" }, keep: 1 }));
  fs.writeFileSync(f.paths.codexFile, 'model = "gpt"\nnotify = ["old.exe"]\napproval = "ask"\n');
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const result = disableIntegration({ userData: f.userData, home: f.home, deleteData: false });
  assert.equal(result.claude, "restored");
  assert.equal(result.codex, "restored");
  const claude = JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8"));
  assert.deepEqual(claude.statusLine, { type: "command", command: "old" });
  assert.equal(claude.keep, 1);
  assert.deepEqual(findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8")).values, ["old.exe"]);
  assert.match(fs.readFileSync(f.paths.codexFile, "utf8"), /approval = "ask"/);
});

test("disable preserves hook changes made by the user after setup", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, "{}\n");
  fs.writeFileSync(f.paths.codexFile, "");
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const claude = JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8"));
  claude.statusLine = { type: "command", command: "new-user-hook" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify(claude, null, 2));
  fs.writeFileSync(f.paths.codexFile, 'notify = ["new-user-hook.exe"]\n');
  const result = disableIntegration({ userData: f.userData, home: f.home });
  assert.equal(result.claude, "preserved-user-change");
  assert.equal(result.codex, "preserved-user-change");
  assert.equal(JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8")).statusLine.command, "new-user-hook");
  assert.deepEqual(findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8")).values, ["new-user-hook.exe"]);
});

test("repair keeps the original hooks instead of wrapping Nexo around itself", () => {
  const f = fixture();
  const originalClaude = { type: "command", command: "original-claude" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ statusLine: originalClaude }));
  fs.writeFileSync(f.paths.codexFile, 'notify = ["original-codex.exe", "done"]\n');
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const before = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));

  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const after = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  assert.deepEqual(after.claude.previousStatusLine, originalClaude);
  assert.equal(after.codex.previousAssignment, before.codex.previousAssignment);
  assert.deepEqual(after.codex.installedValues, before.codex.installedValues);

  disableIntegration({ userData: f.userData, home: f.home });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8")).statusLine, originalClaude);
  assert.deepEqual(findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8")).values, ["original-codex.exe", "done"]);
});

test("launch repair migrates Nexo-owned hooks to the current executable and Claude bridge", () => {
  const f = fixture();
  const originalClaude = { type: "command", command: "original-claude" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ statusLine: originalClaude }));
  fs.writeFileSync(f.paths.codexFile, 'notify = ["original-codex.exe", "done"]\n');
  enableIntegration({
    userData: f.userData,
    home: f.home,
    executable: "C:\\Old\\Nexo.exe",
  });

  const result = repairOwnedIntegration({
    userData: f.userData,
    home: f.home,
    executable: "C:\\New\\Nexo.exe",
    claudeHook: "C:\\New\\resources\\telemetry\\collector\\claude-hook.cmd",
  });

  assert.equal(result.repaired, true);
  const claude = JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8"));
  assert.match(claude.statusLine.command, /claude-hook\.cmd/);
  const notify = findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8"));
  assert.deepEqual(notify.values.slice(0, 2), ["C:\\New\\Nexo.exe", "--telemetry-hook=codex"]);
  const state = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  assert.deepEqual(state.claude.previousStatusLine, originalClaude);
  assert.deepEqual(findNotifyAssignment(state.codex.previousAssignment).values, ["original-codex.exe", "done"]);
});

test("launch repair preserves hooks changed by the user", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, "{}\n");
  fs.writeFileSync(f.paths.codexFile, "");
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Old\\Nexo.exe" });
  const claude = JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8"));
  claude.statusLine = { type: "command", command: "user-owned-status" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify(claude, null, 2));

  const result = repairOwnedIntegration({
    userData: f.userData,
    home: f.home,
    executable: "C:\\New\\Nexo.exe",
    claudeHook: "C:\\New\\claude-hook.cmd",
  });

  assert.equal(result.repaired, false);
  assert.equal(result.reason, "hook-changed");
  assert.equal(JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8")).statusLine.command, "user-owned-status");
  assert.deepEqual(
    findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8")).values,
    ["C:\\Old\\Nexo.exe", "--telemetry-hook=codex"],
  );
});

test("repair treats Codex and Claude independently after one hook changes", () => {
  const f = fixture();
  const originalClaude = { type: "command", command: "original-claude" };
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ statusLine: originalClaude }));
  fs.writeFileSync(f.paths.codexFile, 'notify = ["original-codex.exe"]\n');
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  fs.writeFileSync(f.paths.codexFile, 'notify = ["new-codex.exe"]\n');

  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const state = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  assert.deepEqual(state.claude.previousStatusLine, originalClaude);
  assert.deepEqual(findNotifyAssignment(state.codex.previousAssignment).values, ["new-codex.exe"]);
  assert.deepEqual(state.codex.installedValues.slice(-1), ["new-codex.exe"]);
});

test("enable never records a Nexo-owned statusline as the previous hook", () => {
  // Regression: CLM-statusline-self-delegation-fork-bomb. Recording our own
  // hook as "previous" makes the hook delegate to itself and fork-bomb the PC.
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({
    statusLine: { type: "command", command: "node ./spike/collector/claude-hook.mjs" },
  }));
  fs.writeFileSync(f.paths.codexFile, "");

  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const state = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  assert.equal(state.claude.previousStatusLine, null);

  // The packaged bridge variant must be rejected the same way.
  fs.rmSync(f.paths.stateFile);
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({
    statusLine: { type: "command", command: '"C:\\Old\\Nexo\\resources\\telemetry\\collector\\claude-hook.cmd"' },
  }));
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  assert.equal(JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8")).claude.previousStatusLine, null);
});

test("repair sanitizes a poisoned previousStatusLine already stored in state", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, "{}\n");
  fs.writeFileSync(f.paths.codexFile, "");
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const poisoned = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  poisoned.claude.previousStatusLine = {
    type: "command",
    command: "node ./spike/collector/claude-hook.mjs",
  };
  fs.writeFileSync(f.paths.stateFile, JSON.stringify(poisoned, null, 2));

  const result = repairOwnedIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  assert.equal(result.repaired, true);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8")).claude.previousStatusLine, null);
});

test("enable never delegates Codex notify to a Nexo-owned hook", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, "{}\n");
  fs.writeFileSync(f.paths.codexFile, 'notify = ["C:\\\\Old\\\\Nexo.exe", "--telemetry-hook=codex"]\n');

  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const notify = findNotifyAssignment(fs.readFileSync(f.paths.codexFile, "utf8"));
  assert.deepEqual(notify.values, ["C:\\Apps\\Nexo.exe", "--telemetry-hook=codex"]);
});

test("disable never restores a Nexo-owned statusline from a poisoned state", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, "{}\n");
  fs.writeFileSync(f.paths.codexFile, "");
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  const poisoned = JSON.parse(fs.readFileSync(f.paths.stateFile, "utf8"));
  poisoned.claude.previousStatusLine = {
    type: "command",
    command: "node ./spike/collector/claude-hook.mjs",
  };
  fs.writeFileSync(f.paths.stateFile, JSON.stringify(poisoned, null, 2));

  const result = disableIntegration({ userData: f.userData, home: f.home });
  assert.equal(result.claude, "restored");
  assert.equal(JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8")).statusLine, undefined);
});

test("full removal restores hooks and deletes only Nexo telemetry metadata", () => {
  const f = fixture();
  fs.writeFileSync(f.paths.claudeFile, JSON.stringify({ keep: "native" }));
  fs.writeFileSync(f.paths.codexFile, 'model = "gpt"\n');
  enableIntegration({ userData: f.userData, home: f.home, executable: "C:\\Apps\\Nexo.exe" });
  fs.mkdirSync(path.dirname(f.paths.telemetryFile), { recursive: true });
  fs.writeFileSync(f.paths.telemetryFile, "{}\n");

  const result = disableIntegration({ userData: f.userData, home: f.home, deleteData: true });
  assert.equal(result.removedNexoState, true);
  assert.equal(fs.existsSync(f.paths.stateFile), false);
  assert.equal(fs.existsSync(f.paths.backupDir), false);
  assert.equal(fs.existsSync(f.paths.telemetryFile), false);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.claudeFile, "utf8")).keep, "native");
  assert.match(fs.readFileSync(f.paths.codexFile, "utf8"), /model = "gpt"/);
});
