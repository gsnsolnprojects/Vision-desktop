import { contextBridge, ipcRenderer } from "electron";
import type { EngineInfo, StationApi } from "../shared/ipc";

/** The only surface the renderer gets: a small, typed, promise-based API. No Node access. */
const api: StationApi = {
  engine: {
    info: () => ipcRenderer.invoke("engine:info"),
    restart: () => ipcRenderer.invoke("engine:restart"),
    onChange: (cb) => {
      const listener = (_e: unknown, info: EngineInfo) => cb(info);
      ipcRenderer.on("engine:change", listener);
      return () => ipcRenderer.removeListener("engine:change", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
  backend: {
    request: (req) => ipcRenderer.invoke("backend:request", req),
  },
  dialog: {
    openModelFile: () => ipcRenderer.invoke("dialog:openModelFile"),
  },
  reports: {
    saveRunReport: (runId) => ipcRenderer.invoke("reports:saveRunReport", runId),
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    openLogs: () => ipcRenderer.invoke("app:openLogs"),
    toggleFullscreen: () => ipcRenderer.invoke("app:toggleFullscreen"),
  },
};

contextBridge.exposeInMainWorld("station", api);
