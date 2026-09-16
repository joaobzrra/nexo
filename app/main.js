// AgentTerminal — Electron main process.
// Owns all PTY sessions (node-pty / ConPTY). Renderer is sandboxed and never
// touches node-pty directly — see docs/decisions/001-ui-stack.md.

const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { spawn } = require("node:child_process");
const { createUpdateManager } = require("./updater");
const {
  disableIntegration,
  enableIntegration,
  integrationStatus,
  markPrompted,
  repairOwnedIntegration,
} = require("./telemetry-integration");
const { runTelemetryHook } = require("./telemetry-hook");

// Unpackaged Electron derives app.name from package.json ("nexo") and lands
// on the SAME %APPDATA%\Nexo userData as the installed app — same
// single-instance lock (a running installed Nexo silently kills every dev
// launch with exit 0) and same telemetry state. Give dev its own home before
// anything touches userData (CLM-dev-and-installed-share-userdata-lock).
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "NexoDev"));
}

const TELEMETRY_HOOK_ARG = process.argv.find((arg) => arg.startsWith("--telemetry-hook="));
const UNINSTALL_ARG = process.argv.find((arg) => arg.startsWith("--uninstall-cleanup="));
const SPLASH_MODE = process.argv.includes("--update-splash");
const SPECIAL_MODE = Boolean(TELEMETRY_HOOK_ARG || UNINSTALL_ARG || SPLASH_MODE);
// Hook and uninstall helper processes do not load the native PTY module. This
// keeps them fast and avoids binding cleanup operations to Electron's ABI.
const pty = SPECIAL_MODE ? null : require("node-pty");

const SELFTEST = process.argv.includes("--selftest");
// Boots the full app (window, renderer, pane) and drives a scripted codex
// session through the production input path to reproduce the in-app
// shell-exec hang. Log: app/codex-selftest.log. Exits on its own.
const CODEX_TEST = process.argv.includes("--codex-selftest");
// Exercises split -> close -> split and verifies both PTY count and compact
// display ordinals. Result written to app/ui-selftest.log. Exits on its own.
const UI_TEST = process.argv.includes("--ui-selftest");
// Text-renderer benchmark: drives a synthetic Codex-style full-screen repaint
// and reports renderer-process CPU. --perf-selftest=dom or =webgl picks which
// xterm renderer to measure; result appended to app/perf-selftest.log.
const PERF_ARG = process.argv.find((arg) => arg.startsWith("--perf-selftest"));
const PERF_MODE = PERF_ARG ? PERF_ARG.split("=")[1] || "webgl" : null;
// Escape hatch for a broken GPU driver: --renderer=dom forces xterm's DOM
// renderer. Panes fall back to it on their own if WebGL cannot start.
const RENDERER_ARG = process.argv.find((arg) => arg.startsWith("--renderer="));
const RENDERER_MODE = RENDERER_ARG ? RENDERER_ARG.slice("--renderer=".length) : null;
// Render probe: paint a fixed Codex-shaped payload, then capture it. Combined
// with --capture-ui and --glyphs=/--contrast= it turns a subjective "the text
// looks funny" into a reproducible image diff between renderer settings.
const PAINT_PROBE = process.argv.includes("--paint-probe");
const argValue = (name) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
// Deterministic visual QA: capture Chromium's rendered surface directly. A
// desktop CopyFromScreen capture can be black when hardware composition is on.
const CAPTURE_ARG = process.argv.find((arg) => arg.startsWith("--capture-ui="));
// "Open in Nexo": Explorer's context menu launches us with --open=<folder>.
// A second launch routes the folder into the running window as a new tab.
const openArgFrom = (argv) => {
  const arg = argv.find((a) => a.startsWith("--open="));
  return arg ? arg.slice("--open=".length) : null;
};
const OPEN_PATH = openArgFrom(process.argv);
// Selftests and captures intentionally run parallel instances; only the real
// app takes the single-instance lock.
const AUTOMATED = SELFTEST || CODEX_TEST || UI_TEST || Boolean(CAPTURE_ARG);

// Telemetry is part of the desktop app, not a manual development sidecar.
// Run the zero-dependency collector in Electron's Node mode so a normal launch
// after reboot restores Codex/Claude context instrumentation automatically.
let telemetryCollector = null;
const telemetryToken = crypto.randomBytes(32).toString("base64url");
const telemetryPort = 4317;
function startTelemetryCollector() {
  if (telemetryCollector) return;
  const serverFile = app.isPackaged
    ? path.join(process.resourcesPath, "telemetry", "collector", "server.mjs")
    : path.join(__dirname, "..", "spike", "collector", "server.mjs");
  const stateFile = path.join(app.getPath("userData"), "telemetry-state.json");
  telemetryCollector = spawn(process.execPath, [
    serverFile,
    "--port", String(telemetryPort),
    "--token", telemetryToken,
    "--state-file", stateFile,
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  telemetryCollector.once("exit", () => {
    telemetryCollector = null;
  });
}

function stopTelemetryCollector() {
  if (!telemetryCollector) return;
  try {
    telemetryCollector.kill();
  } catch {}
  telemetryCollector = null;
}
process.once("exit", stopTelemetryCollector);

// ---------------------------------------------------------------- PTY manager ----
// Batches PTY output per Sol's backpressure contract:
//   - flush to the renderer at most every 8ms OR when the buffer exceeds 32KB
//   - cap queued (unflushed) bytes at 4MB; if exceeded, drop and mark it
const FLUSH_INTERVAL_MS = 8;
const FLUSH_BYTES_THRESHOLD = 32 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const TRUNCATION_MARKER = "\r\n[...output truncated by host...]\r\n";

// Strip variables that make spawned CLIs think they run inside another agent
// session. When the app is launched from a shell owned by Claude Code (or via
// npm), panes inherit CLAUDECODE / CLAUDE_CODE_* / npm_* — a nested `claude`
// then treats itself as a child session and stops saving its own transcripts.
function cleanPaneEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_|npm_|ELECTRON_RUN_AS_NODE$)/i.test(key)) {
      delete env[key];
    }
  }
  env.AGENTTERMINAL_TELEMETRY_TOKEN = telemetryToken;
  env.AGENTTERMINAL_TELEMETRY_PORT = String(telemetryPort);
  return env;
}

class PtyManager {
  constructor() {
    /** @type {Map<string, { proc: import('node-pty').IPty, buf: string[], bufBytes: number, timer: NodeJS.Timeout | null, win: BrowserWindow }>} */
    this.sessions = new Map();
    this._nextId = 1;
  }

  createPane(win, opts = {}) {
    const id = String(this._nextId++);
    const shell = "powershell.exe";
    const requestedCwd = typeof opts.cwd === "string" ? opts.cwd : "";
    const cwd = requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory()
      ? path.resolve(requestedCwd)
      : os.homedir();
    const cols = Math.max(20, Math.min(500, Number(opts.cols) || 80));
    const rows = Math.max(5, Math.min(300, Number(opts.rows) || 24));

    const env = cleanPaneEnv();
    env.AGENTTERMINAL_PANE_ID = id; // exact pane<->session link for CLI hooks
    const proc = pty.spawn(shell, [], {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
      useConptyDll: true,
    });

    const session = {
      proc,
      buf: [],
      bufBytes: 0,
      timer: null,
      win,
      cols,
      rows,
    };
    this.sessions.set(id, session);

    if (CODEX_TEST) startCodexTest(this, id, proc);

    proc.onData((data) => this._onData(id, session, data));
    proc.onExit(({ exitCode, signal }) => {
      this._flush(id, session);
      if (!win.isDestroyed()) {
        win.webContents.send("pty:exit", { id, exitCode, signal });
      }
      this.sessions.delete(id);
    });

    return { id, cols, rows, shell, cwd };
  }

  _onData(id, session, data) {
    const bytes = Buffer.byteLength(data, "utf8");
    if (session.bufBytes + bytes > MAX_QUEUED_BYTES) {
      // Drop this chunk, mark once, and keep the session alive.
      if (!session.truncated) {
        session.buf.push(TRUNCATION_MARKER);
        session.bufBytes += Buffer.byteLength(TRUNCATION_MARKER, "utf8");
        session.truncated = true;
      }
      return;
    }
    session.buf.push(data);
    session.bufBytes += bytes;
    session.truncated = false;

    if (session.bufBytes >= FLUSH_BYTES_THRESHOLD) {
      this._flush(id, session);
      return;
    }
    if (!session.timer) {
      session.timer = setTimeout(() => this._flush(id, session), FLUSH_INTERVAL_MS);
    }
  }

  _flush(id, session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.buf.length === 0) return;
    const data = session.buf.join("");
    session.buf = [];
    session.bufBytes = 0;
    if (!session.win.isDestroyed()) {
      session.win.webContents.send("pty:data", { id, data });
    }
  }

  input(id, data) {
    const session = this.sessions.get(id);
    if (session && typeof data === "string" && data.length <= 1024 * 1024) session.proc.write(data);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) {
      cols = Math.max(20, Math.min(500, Number(cols) || 80));
      rows = Math.max(5, Math.min(300, Number(rows) || 24));
      if (session.cols === cols && session.rows === rows) return;
      try {
        session.proc.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
      } catch {
        // ConPTY can throw if the process just exited; ignore.
      }
    }
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(id);
    try {
      // node-pty owns ConPTY and already enumerates/kills the attached console
      // process tree. A second tree-kill races that enumeration on Windows.
      session.proc.kill();
    } catch {
      // already gone
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

const ptyManager = new PtyManager();

function isExactLocalPage(url, expectedFile) {
  try { return path.resolve(fileURLToPath(url)) === path.resolve(expectedFile); }
  catch { return false; }
}

// -------------------------------------------------------------- main window ----
function createWindow(openPath) {
  const pageFile = path.join(__dirname, "renderer", "index.html");
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    // Windows acrylic behind a strong theme tint (see body background in
    // style.css). The renderer owns the dark base color so Windows theme and
    // wallpaper differences cannot wash out the terminal on another PC.
    backgroundColor: "#00000000",
    backgroundMaterial: "acrylic",
    // Frameless with native window controls: the renderer's instrument strip
    // is the title bar (its -webkit-app-region: drag makes it draggable).
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0e131b", symbolColor: "#8a96a7", height: 42 },
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const query = {};
  if (openPath) query.open = openPath;
  if (PERF_MODE) {
    query.bench = "1";
    query.renderer = PERF_MODE;
  } else {
    if (RENDERER_MODE) query.renderer = RENDERER_MODE;
    if (PAINT_PROBE) query.bench = "1";
    for (const name of ["glyphs", "contrast", "opaque"]) {
      const value = argValue(name);
      if (value) query[name] = value;
    }
  }
  win.loadFile(pageFile, Object.keys(query).length ? { query } : undefined);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isExactLocalPage(url, pageFile)) event.preventDefault();
  });
  return win;
}

let mainWin = null;
let setupWin = null;
let updateManager = null;

function integrationOptions() {
  return {
    userData: app.getPath("userData"),
    executable: process.execPath,
    claudeHook: app.isPackaged
      ? path.join(process.resourcesPath, "telemetry", "collector", "claude-hook.cmd")
      : null,
  };
}

function trustedSender(event, win) {
  const expectedFile = win === mainWin
    ? path.join(__dirname, "renderer", "index.html")
    : win === setupWin
      ? path.join(__dirname, "renderer", "telemetry-setup.html")
      : null;
  return Boolean(win && expectedFile && !win.isDestroyed() && event.sender === win.webContents &&
    isExactLocalPage(String(event.senderFrame?.url || ""), expectedFile));
}

function requireSender(event, win) {
  if (!trustedSender(event, win)) throw new Error("Untrusted renderer request");
}

function createTelemetrySetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return setupWin;
  }
  setupWin = new BrowserWindow({
    width: 760,
    height: 690,
    minWidth: 680,
    minHeight: 600,
    parent: mainWin || undefined,
    modal: Boolean(mainWin),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0d131a",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setupWin.removeMenu();
  setupWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const pageFile = path.join(__dirname, "renderer", "telemetry-setup.html");
  setupWin.webContents.on("will-navigate", (event, url) => {
    if (!isExactLocalPage(url, pageFile)) event.preventDefault();
  });
  setupWin.once("ready-to-show", () => setupWin?.show());
  setupWin.once("closed", () => { setupWin = null; });
  setupWin.loadFile(pageFile);
  return setupWin;
}

function registerIpc() {
  ipcMain.handle("pty:create", (event, opts) => {
    requireSender(event, mainWin);
    return ptyManager.createPane(mainWin, opts);
  });
  ipcMain.on("pty:input", (event, payload = {}) => {
    if (trustedSender(event, mainWin)) ptyManager.input(String(payload.id || ""), payload.data);
  });
  ipcMain.on("pty:resize", (event, payload = {}) => {
    if (trustedSender(event, mainWin)) ptyManager.resize(String(payload.id || ""), payload.cols, payload.rows);
  });
  ipcMain.on("pty:kill", (event, payload = {}) => {
    if (trustedSender(event, mainWin)) ptyManager.kill(String(payload.id || ""));
  });

  ipcMain.handle("telemetry:status", (event) => {
    requireSender(event, setupWin);
    return integrationStatus({ userData: app.getPath("userData") });
  });
  ipcMain.handle("telemetry:enable", (event) => {
    requireSender(event, setupWin);
    if (!app.isPackaged) throw new Error("Telemetry integration is enabled from an installed Nexo build.");
    const status = enableIntegration(integrationOptions());
    startTelemetryCollector();
    return status;
  });
  ipcMain.handle("telemetry:disable", (event, options = {}) => {
    requireSender(event, setupWin);
    stopTelemetryCollector();
    return disableIntegration({
      userData: app.getPath("userData"),
      deleteData: options.deleteData === true,
    });
  });
  ipcMain.handle("telemetry:dismiss", (event) => {
    requireSender(event, setupWin);
    return markPrompted({ userData: app.getPath("userData") });
  });
  ipcMain.on("telemetry:close", (event) => {
    if (trustedSender(event, setupWin)) setupWin?.close();
  });
  ipcMain.handle("telemetry:open-settings", (event) => {
    requireSender(event, mainWin);
    createTelemetrySetupWindow();
    return true;
  });
  ipcMain.handle("telemetry:get-url", (event) => {
    requireSender(event, mainWin);
    return `http://127.0.0.1:${telemetryPort}/events?token=${encodeURIComponent(telemetryToken)}`;
  });

  ipcMain.handle("update:get-state", (event) => {
    requireSender(event, mainWin);
    return updateManager?.getState() || { phase: "idle", currentVersion: app.getVersion() };
  });
  ipcMain.handle("update:download", (event) => {
    requireSender(event, mainWin);
    return updateManager?.download();
  });
  ipcMain.handle("update:install", (event) => {
    requireSender(event, mainWin);
    return updateManager?.install();
  });
  ipcMain.handle("update:check", (event) => {
    requireSender(event, mainWin);
    return updateManager?.check();
  });
}

Menu.setApplicationMenu(null);

// The update splash: a second Nexo process showing one small frameless window
// while the silent installer replaces the app. It closes when a fresh real
// launch stamps the sentinel file, or after 90 seconds. A GUI exe survives
// being spawned detached (unlike powershell, which dies without a console),
// which is why the splash is Nexo itself and not a script.
const SPLASH_SENTINEL = "last-launch.txt";

function readLaunchStamp() {
  try {
    return Number(fs.readFileSync(path.join(app.getPath("userData"), SPLASH_SENTINEL), "utf8"));
  } catch {
    return 0;
  }
}

function runUpdateSplash() {
  app.whenReady().then(() => {
    const begin = Date.now();
    const win = new BrowserWindow({
      width: 360,
      height: 120,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      center: true,
      backgroundColor: "#10141b",
      webPreferences: { sandbox: true },
    });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
      <body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:7px;background:#10141b;font-family:'Segoe UI',sans-serif;user-select:none;cursor:default">
        <div style="color:#edf2f4;font-size:16px;font-weight:600">Nexo is updating</div>
        <div style="color:#849097;font-size:11px">It will reopen by itself in a moment.</div>
      </body>`));
    const timer = setInterval(() => {
      const relaunched = readLaunchStamp() > begin;
      if (relaunched || Date.now() - begin > 90_000) {
        clearInterval(timer);
        // Give the relaunched window a beat to paint before the splash goes.
        setTimeout(() => app.exit(0), relaunched ? 700 : 0);
      }
    }, 500);
  });
}

if (SPLASH_MODE) {
  runUpdateSplash();
} else if (SPECIAL_MODE) {
  app.whenReady().then(async () => {
    try {
      if (TELEMETRY_HOOK_ARG) {
        const kind = TELEMETRY_HOOK_ARG.slice("--telemetry-hook=".length);
        const hookIndex = process.argv.indexOf(TELEMETRY_HOOK_ARG);
        await runTelemetryHook(kind, app.getPath("userData"), process.argv.slice(hookIndex + 1));
      } else {
        const mode = UNINSTALL_ARG.slice("--uninstall-cleanup=".length);
        if (mode !== "keep" && mode !== "delete") throw new Error("Invalid uninstall cleanup mode");
        disableIntegration({
          userData: app.getPath("userData"),
          deleteData: mode === "delete",
        });
      }
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
} else if (SELFTEST) {
  // Prove node-pty loads and spawns under Electron's ABI without opening a
  // visible window. This is the #1 risk called out in the decision doc.
  runSelfTest();
} else {
  if (!AUTOMATED) {
    if (!app.requestSingleInstanceLock()) {
      app.exit(0);
    }
    app.on("second-instance", (_evt, argv) => {
      if (!mainWin || mainWin.isDestroyed()) return;
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      const cwd = openArgFrom(argv);
      if (cwd) mainWin.webContents.send("open:folder", { cwd });
    });
  }

  app.whenReady().then(() => {
    // Single source of truth: electron-builder writes this same id into the
    // installer and into Windows' registry entries. Hardcoding it here a second
    // time is how the two silently drift apart, and a mismatch breaks taskbar
    // pinning and update identity for anyone who already installed.
    app.setAppUserModelId(require("./package.json").build.appId);
    // Stamp the launch sentinel so a waiting update splash knows the new
    // version is up and closes itself.
    try {
      fs.writeFileSync(path.join(app.getPath("userData"), SPLASH_SENTINEL), String(Date.now()));
    } catch {}
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    let telemetry = integrationStatus({ userData: app.getPath("userData") });
    if (app.isPackaged && telemetry.enabled) {
      try {
        telemetry = repairOwnedIntegration(integrationOptions());
      } catch {
        // A malformed or user-owned CLI config must not prevent Nexo itself
        // from launching. The settings window remains available for repair.
      }
    }
    if (!app.isPackaged || telemetry.enabled) startTelemetryCollector();
    const win = createWindow(OPEN_PATH);
    mainWin = win;
    registerIpc();
    updateManager = createUpdateManager({
      app,
      dialog,
      getWindow: () => mainWin,
      getPaneCount: () => ptyManager.sessions.size,
    });
    updateManager.start();
    if (app.isPackaged && !telemetry.prompted) {
      win.webContents.once("did-finish-load", () => setTimeout(createTelemetrySetupWindow, 500));
    }

    if (CAPTURE_ARG) {
      const fs = require("node:fs");
      const capturePath = CAPTURE_ARG.slice("--capture-ui=".length);
      win.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes("--capture-ui-rail")) {
              await win.webContents.executeJavaScript(`(() => {
                const ledger = document.getElementById('ledger');
                if (ledger?.classList.contains('min')) document.getElementById('ledger-toggle')?.click();
              })()`);
            }
            if (PAINT_PROBE) {
              await win.webContents.executeJavaScript(
                "window.__nexoPaint ? window.__nexoPaint() : false"
              );
            }
            win.show();
            win.focus();
            win.webContents.invalidate();
            await new Promise((resolve) => setTimeout(resolve, PAINT_PROBE ? 900 : 400));
            const image = await win.webContents.capturePage();
            const png = image.toPNG();
            if (png.length > 0) {
              fs.writeFileSync(capturePath, png);
            } else {
              win.webContents.debugger.attach("1.3");
              const captured = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
                format: "png",
                fromSurface: true,
              });
              fs.writeFileSync(capturePath, Buffer.from(captured.data, "base64"));
              win.webContents.debugger.detach();
            }
            const state = await win.webContents.executeJavaScript(`({
              title: document.title,
              panes: document.querySelectorAll('.pane').length,
              ledgerHidden: document.getElementById('ledger')?.classList.contains('hidden'),
              ledgerDisplay: getComputedStyle(document.getElementById('ledger')).display,
              bodyText: document.body.innerText.slice(0, 1200),
              bodyBounds: document.body.getBoundingClientRect().toJSON(),
              cursorEls: document.querySelectorAll('.xterm-cursor').length,
              canvasEls: document.querySelectorAll('.pane-term canvas').length,
              probe: (window.__nexoProbe && window.__nexoProbe()) || null
            })`);
            fs.writeFileSync(`${capturePath}.json`, JSON.stringify(state, null, 2));
          } catch (error) {
            fs.writeFileSync(`${capturePath}.error.txt`, String(error?.stack || error));
          } finally {
            app.exit(0);
          }
        }, 2500);
      });
    }

    if (UI_TEST) {
      const fs = require("node:fs");
      const shortcut = (keyCode) => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control", "shift"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control", "shift"] });
      };
      setTimeout(() => shortcut("D"), 4000);
      setTimeout(() => shortcut("W"), 5500);
      setTimeout(() => shortcut("D"), 7000);
      // tab lifecycle: open a second tab, then close it; PTY count and the
      // tab strip must both return to the pre-tab state (no PTY leak).
      setTimeout(() => shortcut("T"), 8500);
      // A Codex telemetry repaint can replace a tab node before click. Verify
      // pointerdown switches both ways even though activation redraws the strip.
      setTimeout(() => win.webContents.executeJavaScript(`(() => {
        const switchTo = (index) => {
          const tab = document.querySelectorAll('#tab-strip .tab')[index];
          if (!tab) return false;
          const uid = tab.dataset.tab;
          tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
          return document.querySelector('#tab-strip .tab.active')?.dataset.tab === uid;
        };
        window.__tabPointerSwitchPass = switchTo(0) && switchTo(1);
      })()`), 9250);
      setTimeout(() => shortcut("W"), 10000);
      setTimeout(async () => {
        const n = ptyManager.sessions.size;
        const state = await win.webContents.executeJavaScript(`({
          ordinals: [...document.querySelectorAll('.pane-kicker')].map((el) => el.textContent.trim()),
          tabCount: document.querySelectorAll('#tab-strip .tab').length,
          tabPointerSwitchPass: window.__tabPointerSwitchPass === true,
        })`);
        const ordinalPass = state.ordinals.join(",") === "pane 01,pane 02";
        const pass = n === 2 && ordinalPass && state.tabCount === 1 && state.tabPointerSwitchPass;
        fs.writeFileSync(
          path.join(__dirname, "ui-selftest.log"),
          `${pass ? "PASS" : "FAIL"} panes=${n} tabs=${state.tabCount} tab-switch=${state.tabPointerSwitchPass} ordinals=${state.ordinals.join(",")}\n`
        );
        app.exit(pass ? 0 : 1);
      }, 12500);
    }

    if (PERF_MODE) {
      const fs = require("node:fs");
      // CPU-seconds per process type. Both the renderer and the GPU process
      // are reported: moving work onto the GPU only counts as a win if the
      // total goes down, not if the cost merely changes address.
      const cpuByType = () => {
        const out = {};
        for (const m of app.getAppMetrics()) {
          const seconds = m.cpu?.cumulativeCPUUsage;
          if (typeof seconds !== "number") continue;
          out[m.type] = (out[m.type] || 0) + seconds;
        }
        return out;
      };
      // Chromium suppresses painting for an occluded window, which produces a
      // beautiful and completely meaningless CPU number. Keep the benchmark
      // window on top and focused for the whole run.
      win.show();
      win.focus();
      win.setAlwaysOnTop(true);
      setTimeout(async () => {
        const WARMUP_MS = 2500;
        let line;
        try {
          // Start the run, then take the CPU baseline only after the warm-up
          // window has passed, so shader and glyph-atlas build-up stays out of
          // the steady-state number.
          const pending = win.webContents.executeJavaScript(
            `window.__nexoBench ? window.__nexoBench(8000, 30, ${WARMUP_MS}) : { error: 'no bench hook' }`
          );
          await new Promise((done) => setTimeout(done, WARMUP_MS + 200));
          const before = cpuByType();
          const wallStart = Date.now();
          const result = await pending;
          const after = cpuByType();
          const wallSeconds = (Date.now() - wallStart) / 1000;
          const delta = (type) =>
            Number(((after[type] || 0) - (before[type] || 0)).toFixed(2));
          const tab = delta("Tab");
          const gpu = delta("GPU");
          const total = Number((tab + gpu).toFixed(2));
          // Percent of one core, over the real CPU-sampling window rather than
          // the renderer's own clock, so the two never drift apart.
          const pct = (value) => (wallSeconds ? Math.round((value / wallSeconds) * 100) : 0);
          const perFrame = (value) =>
            result.framesWritten ? Number(((value * 1000) / result.framesWritten).toFixed(2)) : 0;
          // A run where frames were written but almost nothing was painted did
          // not measure the renderer at all — discard it rather than report it.
          const throttled =
            !result.error && result.rendersPerSec < result.framesPerSec * 0.5;
          line = result.error
            ? `FAIL ${PERF_MODE} error=${result.error}`
            : throttled
            ? `INVALID ${PERF_MODE} painting throttled (fps=${result.framesPerSec} renders/s=${result.rendersPerSec})`
            : `${PERF_MODE} active=${result.renderer} grid=${result.cols}x${result.rows} ` +
              `frames=${result.framesWritten} fps=${result.framesPerSec} renders/s=${result.rendersPerSec} ` +
              `rendererCPU=${tab}s(${pct(tab)}%) gpuCPU=${gpu}s(${pct(gpu)}%) ` +
              `totalCPU=${total}s(${pct(total)}% of one core) ` +
              `perFrame=${perFrame(total)}ms(renderer ${perFrame(tab)}ms)`;
        } catch (error) {
          line = `FAIL ${PERF_MODE} ${String(error?.message || error)}`;
        }
        fs.appendFileSync(path.join(__dirname, "perf-selftest.log"), `${line}\n`);
        app.exit(line.startsWith("FAIL") || line.startsWith("INVALID") ? 1 : 0);
      }, 4500);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWin = createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    ptyManager.killAll();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    updateManager?.stop();
    stopTelemetryCollector();
    ptyManager.killAll();
  });
}

let codexTestStarted = false;
function startCodexTest(manager, id, proc) {
  if (codexTestStarted) return; // only script the first pane
  codexTestStarted = true;
  const fs = require("node:fs");
  const logPath = path.join(__dirname, "codex-selftest.log");
  let out = "";
  proc.onData((d) => {
    out += d;
  });
  const type = (s) => manager.input(id, s);
  const cmdArg = process.argv.find((a) => a.startsWith("--codex-cmd="));
  const codexCmd = cmdArg ? cmdArg.slice("--codex-cmd=".length) : "codex -a never -s read-only";
  // --codex-quiet: launch codex then send NOTHING — isolates whether input
  // during MCP-server startup is what produces "MCP startup interrupted".
  const quiet = process.argv.includes("--codex-quiet");
  setTimeout(() => type(codexCmd + "\r"), 8000);
  if (!quiet) {
    setTimeout(() => type("\r"), 45000); // trust prompt, if any
    setTimeout(() => type("Run exactly this shell command and tell me its output: Write-Output 'shell-ok'"), 60000);
    setTimeout(() => type("\r"), 62000);
  }
  setTimeout(() => {
    fs.writeFileSync(logPath, out);
    app.exit(0);
  }, quiet ? 160000 : 240000);
}

function runSelfTest() {
  app.whenReady().then(() => {
    let collected = "";
    let finished = false;

    const proc = pty.spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", "Write-Output AT_SELFTEST_OK"],
      {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: process.env,
        useConpty: true,
        useConptyDll: true,
      }
    );

    const finish = (pass) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (pass) {
        console.log("SELFTEST PASS");
        app.exit(0);
      } else {
        console.log("SELFTEST FAIL — collected output:");
        console.log(collected);
        app.exit(1);
      }
    };

    proc.onData((data) => {
      collected += data;
      if (collected.includes("AT_SELFTEST_OK")) finish(true);
    });

    proc.onExit(() => {
      finish(collected.includes("AT_SELFTEST_OK"));
    });

    const timeout = setTimeout(() => finish(false), 10000);
  });
}
