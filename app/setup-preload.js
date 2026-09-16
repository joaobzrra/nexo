const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexoSetup", {
  status: () => ipcRenderer.invoke("telemetry:status"),
  enable: () => ipcRenderer.invoke("telemetry:enable"),
  disable: (deleteData = false) => ipcRenderer.invoke("telemetry:disable", { deleteData }),
  dismiss: () => ipcRenderer.invoke("telemetry:dismiss"),
  close: () => ipcRenderer.send("telemetry:close"),
});
