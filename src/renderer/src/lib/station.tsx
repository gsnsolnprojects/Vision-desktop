import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EngineInfo } from "../../../shared/ipc";
import { useAuth } from "./auth";
import { EngineClient, useEngine, type DefectEntry, type EngineStatus, type FrameHeader } from "./engine";

export interface LiveFrame {
  header: FrameHeader;
  bitmap: ImageBitmap;
}

type FrameListener = (frame: LiveFrame) => void;
type DefectListener = (defect: DefectEntry) => void;

interface StationState {
  engineInfo: EngineInfo | null;
  client: EngineClient | null;
  status: EngineStatus | null;
  /** Latest frame header, throttled for React (~4 Hz). The canvas subscribes to every frame instead. */
  header: FrameHeader | null;
  streamConnected: boolean;
  refreshStatus(): Promise<void>;
  subscribeFrames(cb: FrameListener): () => void;
  subscribeDefects(cb: DefectListener): () => void;
}

const StationContext = createContext<StationState | null>(null);
const HEADER_UI_INTERVAL_MS = 250;
const STATUS_POLL_MS = 2000;

export function StationProvider({ children }: { children: ReactNode }) {
  const { info: engineInfo, client } = useEngine();
  const { session, profile, backendHeaders } = useAuth();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [header, setHeader] = useState<FrameHeader | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const frameListeners = useRef(new Set<FrameListener>());
  const defectListeners = useRef(new Set<DefectListener>());
  const lastFrame = useRef<LiveFrame | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!client) return;
    try {
      setStatus(await client.status());
    } catch {
      /* engine restarting; the next poll will catch up */
    }
  }, [client]);

  // Poll engine status (camera reconnects, sync queue, GPU) at a calm rate.
  useEffect(() => {
    if (!client) {
      setStatus(null);
      return;
    }
    void refreshStatus();
    const t = window.setInterval(refreshStatus, STATUS_POLL_MS);
    return () => window.clearInterval(t);
  }, [client, refreshStatus]);

  // Keep the engine's backend session current (login, token refresh, engine restart).
  useEffect(() => {
    if (!client) return;
    if (!session || !profile) {
      void client.clearSession().catch(() => undefined);
      return;
    }
    void (async () => {
      const settings = await window.station.settings.get();
      await client
        .setSession({
          apiBase: settings.apiBaseUrl,
          headers: backendHeaders(),
          user: { id: profile.id, email: profile.email, role: profile.role, company: profile.company, companyId: profile.companyId },
          stationName: settings.stationName,
          uploadEnabled: settings.uploadEnabled,
        })
        .catch(() => undefined);
    })();
  }, [client, session?.access_token, profile, backendHeaders]); // eslint-disable-line react-hooks/exhaustive-deps

  // One WebSocket for frames + events, reconnecting with backoff.
  useEffect(() => {
    if (!client) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let lastHeaderPush = 0;
    let decoding = false;

    const connect = () => {
      ws = new WebSocket(client.streamUrl());
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        retry = 0;
        setStreamConnected(true);
      };
      ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status") setStatus(msg.status);
          else if (msg.type === "defect") defectListeners.current.forEach((cb) => cb(msg.defect));
          return;
        }
        // Binary frame: [u32 header length][header JSON][JPEG]
        if (decoding) return; // still decoding the previous frame: drop this one rather than queueing
        const buf = ev.data as ArrayBuffer;
        const view = new DataView(buf);
        const len = view.getUint32(0);
        const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as FrameHeader;
        decoding = true;
        try {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(buf, 4 + len)], { type: "image/jpeg" }));
          const frame = { header: hdr, bitmap };
          const prev = lastFrame.current;
          lastFrame.current = frame;
          frameListeners.current.forEach((cb) => cb(frame));
          prev?.bitmap.close();
        } catch {
          /* corrupt frame; skip */
        } finally {
          decoding = false;
        }
        const now = performance.now();
        if (now - lastHeaderPush >= HEADER_UI_INTERVAL_MS) {
          lastHeaderPush = now;
          setHeader(hdr);
        }
      };
      ws.onclose = () => {
        setStreamConnected(false);
        if (closed) return;
        retry += 1;
        retryTimer = window.setTimeout(connect, Math.min(500 * 2 ** retry, 5000));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      ws?.close();
      setStreamConnected(false);
    };
  }, [client]);

  // Clear the last frame when a run ends so the next run doesn't flash a stale image.
  useEffect(() => {
    if (status && status.state !== "running") {
      lastFrame.current?.bitmap.close();
      lastFrame.current = null;
      setHeader(null);
    }
  }, [status?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const subscribeFrames = useCallback((cb: FrameListener) => {
    frameListeners.current.add(cb);
    if (lastFrame.current) cb(lastFrame.current);
    return () => {
      frameListeners.current.delete(cb);
    };
  }, []);

  const subscribeDefects = useCallback((cb: DefectListener) => {
    defectListeners.current.add(cb);
    return () => {
      defectListeners.current.delete(cb);
    };
  }, []);

  const value = useMemo<StationState>(
    () => ({ engineInfo, client, status, header, streamConnected, refreshStatus, subscribeFrames, subscribeDefects }),
    [engineInfo, client, status, header, streamConnected, refreshStatus, subscribeFrames, subscribeDefects],
  );
  return <StationContext.Provider value={value}>{children}</StationContext.Provider>;
}

export function useStation(): StationState {
  const ctx = useContext(StationContext);
  if (!ctx) throw new Error("useStation must be used inside StationProvider");
  return ctx;
}
