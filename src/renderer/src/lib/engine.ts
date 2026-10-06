import { useEffect, useMemo, useState } from "react";
import type { EngineInfo } from "../../../shared/ipc";

// ---------- engine API types ----------

export interface StationModel {
  id: string;
  name: string;
  modelType: string;
  classNames: string[];
  source: "library" | "file";
  backendModelId: string | null;
  company: string | null;
  project: string | null;
  projectId: string | null;
  modelVersion: string | null;
  metrics: { mAP50?: number; precision?: number; recall?: number } | null;
  importedAt: string | null;
  sizeBytes: number;
}

export interface CameraInfo {
  id: string;
  kind: string;
  name: string;
}

export interface LiveSettings {
  confidence: number;
  goodClasses: string[];
  verdictEnabled: boolean;
  defectLoggingEnabled: boolean;
  centerGuideEnabled: boolean;
  centerGuidePercent: number;
}

export interface RunAnalytics {
  framesProcessed: number;
  totalProducts: number;
  goodProducts: number;
  badProducts: number;
  classCounts: Record<string, number>;
  runStartedAt?: string;
}

export interface RunStats {
  framesInferred?: number;
  framesSkipped?: number;
  inferenceErrors?: number;
  avgInferMs?: number | null;
  inferMs?: number | null;
  latencyMs?: number | null;
  inferFps?: number | null;
  cameraFps?: number | null;
}

export type Verdict = "NO_PRODUCT" | "OK" | "NOT_OK";

export interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  polygon?: [number, number][];
}

export interface FrameHeader {
  type: "frame";
  runId: string;
  seq: number;
  width: number;
  height: number;
  detections: Detection[];
  verdict: Verdict | null;
  frameVerdict: Verdict | null;
  productInRegion: boolean;
  analytics: RunAnalytics;
  defectCount: number;
  stats: RunStats & { inferMsFrame?: number; latencyMsFrame?: number };
}

export interface DefectEntry {
  id: string;
  runId: string;
  timestamp: string;
  verdict: "NOT_OK";
  defectClasses: string[];
  synced?: boolean;
}

export interface ActiveRun {
  id: string;
  startedAt: string;
  live: LiveSettings & Record<string, unknown>;
  camera: { status: "connecting" | "streaming" | "reconnecting"; error: string | null; resolution: [number, number] };
  analytics: RunAnalytics;
  stats: RunStats;
}

export interface EngineStatus {
  state: "idle" | "starting" | "running" | "stopping";
  lastError: string | null;
  gpu: { cuda: boolean; name: string | null; index: number | null; device: string; count: number; live: GpuLive | null };
  model: StationModel | null;
  run: ActiveRun | null;
  sync: { enabled: boolean; signedIn: boolean; pendingRuns: number; lastError: string | null; lastSuccessAt: string | null };
}

export interface GpuLive {
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number;
  powerW?: number;
}

export interface GpuSystemInfo {
  cuda: boolean;
  cudaVersion: string | null;
  driverVersion: string | null;
  gpus: { index: number; name: string; memoryTotalMb: number; computeCapability?: string; usable?: boolean; live?: GpuLive | null }[];
}

export interface RunRecord {
  id: string;
  name: string | null;
  notes: string | null;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "interrupted";
  model: { id: string; name: string; modelType: string | null; backendModelId: string | null };
  company: string | null;
  project: string | null;
  projectId: string | null;
  user: { id: string; email?: string | null } | null;
  cameraName: string | null;
  config: {
    live?: LiveSettings;
    camera?: { cameraId: string; cameraName?: string; width: number; height: number; fps: number };
    precision?: string;
    presetName?: string | null;
  };
  analytics: Partial<RunAnalytics>;
  stats: RunStats;
  defectCount: number;
  syncState: "pending" | "synced" | "local_only";
  syncError: string | null;
  backendRunId: string | null;
}

export interface DownloadJob {
  id: string;
  modelId: string;
  status: "running" | "done" | "failed";
  bytesDone: number;
  bytesTotal: number | null;
  error: string | null;
}

export interface StartRunRequest {
  modelId: string;
  camera: { cameraId: string; cameraName?: string; width: number; height: number; fps: number };
  live: LiveSettings;
  precision: "fp32" | "fp16";
  gpuIndex?: number | null;
  streamQuality?: number;
  presetName?: string | null;
}

// ---------- client ----------

export class EngineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class EngineClient {
  constructor(readonly baseUrl: string, readonly wsUrl: string, private readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { "x-engine-token": this.token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new EngineError("Inference engine is not reachable", 0);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error ?? (typeof data?.detail === "string" ? data.detail : null) ?? `Engine error ${res.status}`;
      throw new EngineError(String(Array.isArray(data?.detail) ? data.detail.map((d: { msg: string }) => d.msg).join("; ") : msg), res.status);
    }
    return data as T;
  }

  status = () => this.request<EngineStatus>("GET", "/status");
  gpus = () => this.request<GpuSystemInfo>("GET", "/gpus");
  cameras = () => this.request<{ cameras: CameraInfo[] }>("GET", "/cameras").then((r) => r.cameras);
  models = () => this.request<{ models: StationModel[] }>("GET", "/models").then((r) => r.models);
  importModel = (path: string, name?: string) =>
    this.request<{ model: StationModel }>("POST", "/models/import", { path, name }).then((r) => r.model);
  downloadModel = (info: Record<string, unknown>) =>
    this.request<{ job: DownloadJob }>("POST", "/models/download", info).then((r) => r.job);
  downloadStatus = (jobId: string) =>
    this.request<{ job: DownloadJob }>("GET", `/models/download/${jobId}`).then((r) => r.job);
  deleteModel = (id: string) => this.request("DELETE", `/models/${encodeURIComponent(id)}`);

  startRun = (req: StartRunRequest) => this.request<EngineStatus>("POST", "/runs/start", req);
  stopRun = () => this.request<{ run: RunRecord | null }>("POST", "/runs/stop").then((r) => r.run);
  updateLive = (patch: Partial<LiveSettings>) =>
    this.request<{ live: LiveSettings }>("PATCH", "/runs/live", patch).then((r) => r.live);
  runs = () => this.request<{ runs: RunRecord[] }>("GET", "/runs").then((r) => r.runs);
  run = (id: string) => this.request<{ run: RunRecord; defects: DefectEntry[] }>("GET", `/runs/${id}`);
  deleteRun = (id: string) => this.request("DELETE", `/runs/${id}`);
  updateRunMeta = (id: string, meta: { name?: string | null; notes?: string | null }) =>
    this.request<{ run: RunRecord }>("PATCH", `/runs/${id}`, meta).then((r) => r.run);
  syncNow = () => this.request("POST", "/sync/now");

  setSession = (session: { apiBase: string; headers: Record<string, string>; user: Record<string, unknown>; stationName?: string; uploadEnabled?: boolean }) =>
    this.request("POST", "/session", session);
  clearSession = () => this.request("DELETE", "/session");

  defectImageUrl(runId: string, defectId: string): string {
    return `${this.baseUrl}/runs/${runId}/defects/${defectId}/image?t=${this.token}`;
  }

  streamUrl(): string {
    return `${this.wsUrl}?t=${this.token}`;
  }
}

/** Current engine process info (from the main process) and a client when it is ready. */
export function useEngine(): { info: EngineInfo | null; client: EngineClient | null } {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void window.station.engine.info().then((i) => alive && setInfo(i));
    const off = window.station.engine.onChange((i) => setInfo(i));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const client = useMemo(
    () => (info?.state === "ready" && info.baseUrl && info.wsUrl && info.token ? new EngineClient(info.baseUrl, info.wsUrl, info.token) : null),
    [info?.state, info?.baseUrl, info?.wsUrl, info?.token],
  );
  return { info, client };
}
