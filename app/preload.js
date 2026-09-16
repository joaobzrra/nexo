// AgentTerminal — preload. Narrow contextBridge surface only; no Node APIs
// leak into the renderer. See docs/decisions/001-ui-stack.md.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentTerminal", {
  // "10.0.26200" — xterm's ConPTY handling differs by Windows build; it must
  // get the real one or it enables legacy-build redraw workarounds.
  hostInfo: {
    osVersion:
      typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "",
    operatorInitials: String(process.env.USERNAME || "ME")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "ME",
  },
  ptyCreate: (opts) => ipcRenderer.invoke("pty:create", opts),
  ptyInput: (id, data) => ipcRenderer.send("pty:input", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send("pty:resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send("pty:kill", { id }),
  telemetryUrl: () => ipcRenderer.invoke("telemetry:get-url"),
  openTelemetrySettings: () => ipcRenderer.invoke("telemetry:open-settings"),
  updateGetState: () => ipcRenderer.invoke("update:get-state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  onPtyData: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onOpenFolder: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("open:folder", listener);
    return () => ipcRenderer.removeListener("open:folder", listener);
  },
  onPtyExit: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
});
