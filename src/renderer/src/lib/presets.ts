import type { LiveSettings } from "./engine";

/** A saved run configuration ("Line 1 – Bottle cap"). Stored per station. */
export interface RunPreset {
  id: string;
  name: string;
  modelId: string;
  cameraId: string;
  cameraName?: string;
  width: number;
  height: number;
  fps: number;
  precision: Precision;
  live: LiveSettings;
  display: DisplaySettings;
  updatedAt: string;
}

export type Precision = "fp32" | "fp16" | "trt";

export interface DisplaySettings {
  showBoxes: boolean;
  showPolygons: boolean;
  showLabels: boolean;
}

export const DEFAULT_LIVE: LiveSettings = {
  confidence: 0.25,
  goodClasses: ["product"],
  verdictEnabled: true,
  defectLoggingEnabled: true,
  centerGuideEnabled: true,
  centerGuidePercent: 40,
};

export const DEFAULT_DISPLAY: DisplaySettings = { showBoxes: true, showPolygons: true, showLabels: true };

const KEY = "station.presets.v1";
const LAST_KEY = "station.lastConfig.v1";
const LAST_FPS_MIGRATED = "station.lastConfig.autoFps";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: presets are a convenience */
  }
}

export function listPresets(): RunPreset[] {
  return read<RunPreset[]>(KEY, []).sort((a, b) => a.name.localeCompare(b.name));
}

export const PRESET_NAME_MAX = 60;

export type PresetConfig = Omit<RunPreset, "id" | "name" | "updatedAt">;

/** Returns an error message, or null if the name is usable. `exceptId` = the preset being renamed. */
export function validatePresetName(name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a preset name.";
  if (n.length > PRESET_NAME_MAX) return `Keep the name under ${PRESET_NAME_MAX} characters.`;
  const taken = read<RunPreset[]>(KEY, []).some((x) => x.id !== exceptId && x.name.trim().toLowerCase() === n.toLowerCase());
  return taken ? "A preset with this name already exists." : null;
}

export function createPreset(name: string, cfg: PresetConfig): RunPreset {
  const err = validatePresetName(name);
  if (err) throw new Error(err);
  const preset: RunPreset = { ...cfg, name: name.trim(), id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
  write(KEY, [...read<RunPreset[]>(KEY, []), preset]);
  return preset;
}

/** Overwrite an existing preset's settings and name, keeping its id. */
export function updatePreset(id: string, name: string, cfg: PresetConfig): RunPreset {
  const all = read<RunPreset[]>(KEY, []);
  if (!all.some((x) => x.id === id)) throw new Error("This preset no longer exists.");
  const err = validatePresetName(name, id);
  if (err) throw new Error(err);
  const preset: RunPreset = { ...cfg, name: name.trim(), id, updatedAt: new Date().toISOString() };
  write(KEY, all.map((x) => (x.id === id ? preset : x)));
  return preset;
}

/** Stable comparison key for "has anything changed since the preset was saved". */
export function presetConfigKey(cfg: PresetConfig): string {
  return JSON.stringify({
    modelId: cfg.modelId,
    cameraId: cfg.cameraId,
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    precision: cfg.precision,
    live: { ...cfg.live, goodClasses: [...cfg.live.goodClasses].sort() },
    display: { ...DEFAULT_DISPLAY, ...(cfg.display ?? {}) },
  });
}

export function deletePreset(id: string): void {
  write(KEY, read<RunPreset[]>(KEY, []).filter((x) => x.id !== id));
}

export function loadLastConfig(): Omit<RunPreset, "id" | "name" | "updatedAt"> | null {
  const cfg = read<Omit<RunPreset, "id" | "name" | "updatedAt"> | null>(LAST_KEY, null);
  // One-time switch to Auto frame rate (the new default) for setups saved before it existed.
  // Named presets are left exactly as the user saved them.
  if (localStorage.getItem(LAST_FPS_MIGRATED) !== "1") {
    if (cfg) {
      cfg.fps = 0;
      write(LAST_KEY, cfg);
    }
    try {
      localStorage.setItem(LAST_FPS_MIGRATED, "1");
    } catch {
      /* ignore */
    }
  }
  return cfg;
}

export function saveLastConfig(cfg: Omit<RunPreset, "id" | "name" | "updatedAt">): void {
  write(LAST_KEY, cfg);
}

export function loadDisplay(): DisplaySettings {
  return { ...DEFAULT_DISPLAY, ...read<Partial<DisplaySettings>>("station.display.v1", {}) };
}

export function saveDisplay(d: DisplaySettings): void {
  write("station.display.v1", d);
}
