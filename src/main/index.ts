import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { EngineManager } from "./engine";
import log from "./log";
import { getSettings, updateSettings } from "./settings";
import type { AppInfo, AppSettings, BackendRequest, BackendResponse } from "../shared/ipc";

const dataDir = join(app.getPath("userData"), "station");
const engine = new EngineManager(dataDir);
let win: BrowserWindow | null = null;
let quitting = false;

// Development only, opt-in: VISIONM_DEBUG_PORT=9223 exposes the DevTools protocol on localhost for debugging.
if (!app.isPackaged && process.env.VISIONM_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.VISIONM_DEBUG_PORT);
}

// One station app per machine: a second instance would fight over the camera and GPU.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function createWindow(): void {
  const settings = getSettings();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#0f172a",
    title: "Vision-M Station",
    autoHideMenuBar: true,
    fullscreen: settings.startFullscreen,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // keep the live feed rendering when the window is behind others
    },
  });

  win.once("ready-to-show", () => win?.show());

  // The renderer is a local app: never navigate away or open new windows inside it.
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  app.on("child-process-gone", (_e, details) => {
    log.error(`Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ""}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error(`Renderer crashed: reason=${details.reason} exitCode=${details.exitCode}`);
    if (!quitting && details.reason !== "clean-exit") win?.reload();
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

/** Backend calls go through the main process: no CORS dependency, and only the configured backend is reachable. */
async function backendRequest(req: BackendRequest): Promise<BackendResponse> {
  const base = getSettings().apiBaseUrl.replace(/\/+$/, "");
  if (!req.path.startsWith("/") || req.path.includes("..")) {
    return { ok: false, status: 0, data: null, error: "Invalid path" };
  }
  const url = new URL(base + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.body);
  }
  try {
    const res = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const error = res.ok
      ? null
      : (data && typeof data === "object" && ("message" in data || "error" in data)
          ? String((data as Record<string, unknown>).message ?? (data as Record<string, unknown>).error)
          : `HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: `Cannot reach backend (${msg})` };
  }
}

function registerIpc(): void {
  ipcMain.handle("engine:info", () => engine.info());
  ipcMain.handle("engine:restart", async () => {
    await engine.restart();
    return engine.info();
  });
  engine.on("change", (info) => win?.webContents.send("engine:change", info));

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => updateSettings(patch));

  ipcMain.handle("backend:request", (_e, req: BackendRequest) => backendRequest(req));

  ipcMain.handle("dialog:openModelFile", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Load model file",
      properties: ["openFile"],
      filters: [
        { name: "Model weights", extensions: ["pt", "pth", "onnx", "engine"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle("reports:saveRunReport", async (_e, runId: string) => {
    if (!/^[\w-]+$/.test(runId)) return { saved: false, error: "Invalid run id" };
    const res = await dialog.showSaveDialog(win!, {
      title: "Export run report",
      defaultPath: join(app.getPath("documents"), `${runId}.xlsx`),
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    try {
      const r = await engine.fetchEngine(`/runs/${runId}/report.xlsx`);
      if (!r.ok) return { saved: false, error: `Engine returned ${r.status}` };
      await writeFile(res.filePath, Buffer.from(await r.arrayBuffer()));
      return { saved: true, path: res.filePath };
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("app:info", (): AppInfo => ({
    version: app.getVersion(),
    dataDir,
    logsDir: join(dataDir, "logs"),
    isPackaged: app.isPackaged,
  }));
  ipcMain.handle("app:openLogs", () => shell.openPath(join(dataDir, "logs")));
  ipcMain.handle("app:openRuntimeLog", () => shell.openPath(engine.runtime.logPath));
  ipcMain.handle("app:toggleFullscreen", () => {
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  engine.start();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (e) => {
  if (quitting) return;
  // Stop the engine gracefully so the active run is closed and flushed before exit.
  e.preventDefault();
  quitting = true;
  log.info("Shutting down");
  engine.stop().finally(() => app.exit(0));
});

process.on("uncaughtException", (err) => log.error(`Uncaught exception: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (err) => log.error(`Unhandled rejection: ${String(err)}`));
