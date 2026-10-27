import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/ipc";

const DEFAULTS: AppSettings = {
  apiBaseUrl: import.meta.env.VITE_DEFAULT_API_BASE_URL || "http://localhost:3000/api",
  stationName: hostname(),
  startFullscreen: false,
  uploadEnabled: false,
  gpuIndex: null,
  snapshotRetentionDays: 30,
};

function path(): string {
  return join(app.getPath("userData"), "settings.json");
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(readFileSync(path(), "utf8")) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings() };
  if (typeof patch.apiBaseUrl === "string") {
    const url = new URL(patch.apiBaseUrl.trim()); // throws on invalid URL
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Backend URL must be http(s)");
    next.apiBaseUrl = url.toString().replace(/\/+$/, "");
  }
  if (typeof patch.stationName === "string" && patch.stationName.trim()) next.stationName = patch.stationName.trim();
  if (typeof patch.startFullscreen === "boolean") next.startFullscreen = patch.startFullscreen;
  if (typeof patch.uploadEnabled === "boolean") next.uploadEnabled = patch.uploadEnabled;
  if (patch.gpuIndex === null || (Number.isInteger(patch.gpuIndex) && (patch.gpuIndex as number) >= 0)) next.gpuIndex = patch.gpuIndex ?? null;
  if ([0, 7, 30, 90, 365].includes(patch.snapshotRetentionDays as number)) {
    next.snapshotRetentionDays = patch.snapshotRetentionDays as AppSettings["snapshotRetentionDays"];
  }
  const tmp = `${path()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path());
  cache = next;
  return next;
}
