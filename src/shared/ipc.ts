/** Types shared by the main process, preload bridge and renderer. */

export type EngineState = "installing" | "starting" | "ready" | "restarting" | "failed" | "stopped";

/** First-run AI runtime installation progress (packaged app only). */
export interface RuntimeSetup {
  phase: "idle" | "checking" | "creating" | "downloading" | "installing" | "verifying" | "done" | "failed";
  message: string;
  detail: string | null;
  log: string[];
  error: string | null;
  startedAt: string | null;
}

export interface EngineInfo {
  state: EngineState;
  baseUrl: string | null;
  wsUrl: string | null;
  token: string | null;
  error: string | null;
  restarts: number;
  setup: RuntimeSetup | null;
}

export interface AppSettings {
  apiBaseUrl: string;
  stationName: string;
  startFullscreen: boolean;
  /** Upload runs to Vision-M Studio. Off: runs are kept on this PC only (queued for later). */
  uploadEnabled: boolean;
  /** Which NVIDIA GPU runs inference on multi-GPU PCs. null = the first one. */
  gpuIndex: number | null;
  /** Delete defect snapshot images older than this many days (0 = keep forever). Run records are always kept. */
  snapshotRetentionDays: 0 | 7 | 30 | 90 | 365;
}

export interface BackendRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // relative to the API base, e.g. "/inference/models"
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BackendResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logsDir: string;
  isPackaged: boolean;
}

export interface StationApi {
  engine: {
    info(): Promise<EngineInfo>;
    restart(): Promise<EngineInfo>;
    onChange(cb: (info: EngineInfo) => void): () => void;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  backend: {
    request<T = unknown>(req: BackendRequest): Promise<BackendResponse<T>>;
  };
  dialog: {
    openModelFile(): Promise<string | null>;
  };
  reports: {
    saveRunReport(runId: string): Promise<{ saved: boolean; path?: string; error?: string }>;
  };
  app: {
    info(): Promise<AppInfo>;
    openLogs(): Promise<void>;
    openRuntimeLog(): Promise<void>;
    toggleFullscreen(): Promise<boolean>;
  };
}
