const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

test("updater requires explicit download and warns before install", async () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const fakeUpdater = new EventEmitter();
  fakeUpdater.checkForUpdates = async () => fakeUpdater.emit("update-available", { version: "0.1.2" });
  let downloaded = 0;
  fakeUpdater.downloadUpdate = async () => { downloaded += 1; fakeUpdater.emit("update-downloaded", { version: "0.1.2" }); };
  let installed = 0;
  let installArgs = null;
  let splashes = 0;
  fakeUpdater.quitAndInstall = (...args) => { installed += 1; installArgs = args; };
  Module._load = function (request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater: fakeUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../updater")];
  const { createUpdateManager } = require("../updater");
  Module._load = originalLoad;

  const sent = [];
  const prompts = [];
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => "0.1.1" },
    dialog: { showMessageBox: async (_win, options) => { prompts.push(options); return { response: 0 }; } },
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, state) => sent.push(state) } }),
    getPaneCount: () => 3,
    updater: fakeUpdater,
    spawnSplash: () => { splashes += 1; },
  });
  await manager.check();
  assert.equal(manager.getState().phase, "available");
  assert.equal(downloaded, 0);
  await manager.download();
  assert.equal(downloaded, 1);
  assert.equal(manager.getState().phase, "ready");
  await manager.install();
  assert.equal(installed, 1);
  // Silent install + relaunch: no assisted wizard after the user confirmed.
  assert.deepEqual(installArgs, [true, true]);
  // The detached splash covers the quit -> relaunch gap.
  assert.equal(splashes, 1);
  assert.match(prompts[0].detail, /reopen by itself/);
  assert.match(prompts[0].detail, /close 3 live terminal sessions/);
  assert.equal(fakeUpdater.autoDownload, false);
  assert.equal(fakeUpdater.autoInstallOnAppQuit, false);
  assert.ok(sent.length >= 3);
});
