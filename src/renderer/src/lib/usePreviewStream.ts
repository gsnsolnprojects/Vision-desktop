import { useEffect, useRef, useState, type RefObject } from "react";
import type { CameraControlValues, PreviewHeader, StartRunRequest } from "./engine";
import { useStation } from "./station";
import { errorMessage } from "./utils";

const KEEPALIVE_MS = 15_000;
const RESTART_DEBOUNCE_MS = 400;

export interface PreviewStream {
  hdr: PreviewHeader | null;
  error: string | null;
  starting: boolean;
  /** Best focus score seen since the stream started (or since resetPeak). */
  peak: number;
  resetPeak(): void;
}

interface Options {
  camera: StartRunRequest["camera"] | null;
  /** Image controls to open the camera with; later changes are applied live by the caller. */
  controls?: CameraControlValues | null;
  enabled: boolean;
  /** Preview frame width; omit for the light default, or pass the camera width for full resolution. */
  maxWidth?: number;
  canvasRef: RefObject<HTMLCanvasElement>;
  /** Draw extra overlays after each frame (e.g. the centre guide). */
  onDraw?(ctx: CanvasRenderingContext2D, header: PreviewHeader): void;
  /** Stop the engine preview when this stream ends (false when another view takes the camera over). */
  stopOnEnd?: boolean;
}

/** Runs an engine camera preview (no model) and draws its frames on a canvas. */
export function usePreviewStream({ camera, controls, enabled, maxWidth, canvasRef, onDraw, stopOnEnd = true }: Options): PreviewStream {
  const { client, subscribePreview } = useStation();
  const [hdr, setHdr] = useState<PreviewHeader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [peak, setPeak] = useState(0);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const drawRef = useRef(onDraw);
  drawRef.current = onDraw;
  const cameraKey = camera ? JSON.stringify(camera) : "";

  useEffect(() => {
    if (!enabled || !client || !camera) return;
    let cancelled = false;
    setStarting(true);
    setError(null);
    setHdr(null);
    setPeak(0);
    const t = window.setTimeout(() => {
      client
        .previewStart({ ...camera, controls: controlsRef.current ?? null }, maxWidth)
        .catch((err) => !cancelled && setError(errorMessage(err)))
        .finally(() => !cancelled && setStarting(false));
    }, RESTART_DEBOUNCE_MS);
    const keep = window.setInterval(() => void client.previewKeepalive().catch(() => undefined), KEEPALIVE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.clearInterval(keep);
      if (stopOnEnd) void client.previewStop().catch(() => undefined);
    };
  }, [enabled, client, cameraKey, maxWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return;
    let lastUi = 0;
    return subscribePreview(({ header, bitmap }) => {
      if (camera && header.cameraId !== camera.cameraId) return;
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== header.width || canvas.height !== header.height) {
          canvas.width = header.width;
          canvas.height = header.height;
        }
        const ctx = canvas.getContext("2d", { alpha: false });
        if (ctx) {
          try {
            ctx.drawImage(bitmap, 0, 0);
            drawRef.current?.(ctx, header);
          } catch {
            /* bitmap superseded */
          }
        }
      }
      const now = performance.now();
      if (now - lastUi > 250) {
        lastUi = now;
        setHdr(header);
        setStarting(false);
        if (header.sharpness != null) setPeak((p) => Math.max(p, header.sharpness!));
      }
    });
  }, [enabled, subscribePreview, cameraKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { hdr, error, starting, peak, resetPeak: () => setPeak(hdr?.sharpness ?? 0) };
}
