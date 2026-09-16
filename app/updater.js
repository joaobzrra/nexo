const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");

// The silent installer leaves a visible gap: the app quits, nothing shows for
// a few seconds, then the new version relaunches. A second Nexo process in
// --update-splash mode (main.js) fills that gap with a small frameless
// window. It must be our own GUI exe: DETACHED_PROCESS kills powershell
// without a console, and a non-detached child dies with the quitting app.
function spawnUpdateSplash() {
  try {
    const child = spawn(process.execPath, ["--update-splash"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {}
}

function createUpdateManager({ app, dialog, getWindow, getPaneCount, updater = autoUpdater, spawnSplash = spawnUpdateSplash }) {
  let state = { phase: "idle", currentVersion: app.getVersion() };
  let interval = null;
  let checking = false;

  const publish = (patch) => {
    state = { ...state, ...patch, currentVersion: app.getVersion() };
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("update:state", state);
    return state;
  };

  const quietError = (error) => {
    const message = String(error?.message || error || "Update failed").slice(0, 240);
    if (["available", "downloading", "ready"].includes(state.phase)) publish({ phase: "error", message });
    else publish({ phase: "idle", message: null });
  };

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.on("checking-for-update", () => publish({ phase: "checking", message: null }));
  updater.on("update-available", (info) => publish({
    phase: "available",
    version: info.version,
    releaseName: info.releaseName || null,
    percent: 0,
  }));
  updater.on("update-not-available", () => publish({ phase: "idle", version: null, percent: 0 }));
  updater.on("download-progress", (progress) => publish({
    phase: "downloading",
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
  }));
  updater.on("update-downloaded", (info) => publish({
    phase: "ready",
    version: info.version,
    percent: 100,
  }));
  updater.on("error", quietError);

  async function check() {
    if (!app.isPackaged || checking) return state;
    checking = true;
    try { await updater.checkForUpdates(); } catch (error) { quietError(error); }
    finally { checking = false; }
    return state;
  }

  async function download() {
    if (state.phase !== "available") return state;
    publish({ phase: "downloading", percent: 0, message: null });
    try { await updater.downloadUpdate(); } catch (error) { quietError(error); }
    return state;
  }

  async function install() {
    if (state.phase !== "ready") return { installed: false, reason: "not-ready" };
    const paneCount = Math.max(0, Number(getPaneCount()) || 0);
    const closes = paneCount === 0
      ? ""
      : `Restarting to update will close ${paneCount} live terminal ${paneCount === 1 ? "session" : "sessions"}. Finish or save active work first.\n\n`;
    const detail = `${closes}Nexo will close, update quietly for a few seconds, and reopen by itself.`;
    const result = await dialog.showMessageBox(getWindow(), {
      type: "warning",
      title: "Restart and update Nexo",
      message: `Nexo ${state.version || "update"} is ready`,
      detail,
      buttons: ["Restart and update", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return { installed: false, reason: "cancelled" };
    // Silent install: the user already confirmed twice (Download, then this
    // dialog). Re-running the assisted wizard here read as a full reinstall.
    // The detached splash covers the quit -> relaunch gap.
    spawnSplash();
    updater.quitAndInstall(true, true);
    return { installed: true };
  }

  function start() {
    if (!app.isPackaged) return;
    setTimeout(check, 15_000).unref();
    interval = setInterval(check, 15 * 60_000);
    interval.unref();
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  return { check, download, getState: () => state, install, publish, start, stop };
}

module.exports = { createUpdateManager };
