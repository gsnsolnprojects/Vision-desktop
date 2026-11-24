import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CameraControlValues, StartRunRequest } from "@/lib/engine";
import { usePreviewStream } from "@/lib/usePreviewStream";
import { cn } from "@/lib/utils";

const DARK_BELOW = 35;

interface Props {
  camera: StartRunRequest["camera"] | null;
  /** Image controls to open the camera with (changes after that are applied live, without restarting). */
  controls?: CameraControlValues | null;
  /** Disabled while a run owns the camera. */
  disabled?: boolean;
  /** Paused while another view (the full-screen tuner) is using the camera; resumes afterwards. */
  suspended?: boolean;
}

/**
 * Small live camera picture in Run Setup (no model). Off until the operator turns it on, so the
 * camera isn't held open needlessly; stops when leaving the page.
 */
export function CameraPreview({ camera, controls, disabled, suspended }: Props) {
  const [on, setOn] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { hdr, error, starting, peak, resetPeak } = usePreviewStream({
    camera,
    controls,
    enabled: on && !disabled && !suspended,
    canvasRef,
  });

  useEffect(() => {
    if (disabled) setOn(false);
  }, [disabled]);

  const sharp = hdr?.sharpness ?? null;
  const pct = sharp != null && peak > 0 ? Math.min(100, (sharp / peak) * 100) : 0;
  const dark = hdr?.brightness != null && hdr.brightness < DARK_BELOW;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Live preview</span>
        <Button size="sm" variant={on ? "secondary" : "outline"} onClick={() => setOn((v) => !v)} disabled={disabled || !camera}>
          {on ? <EyeOff className="mr-1.5 h-3.5 w-3.5" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
          {on ? "Hide preview" : "Show preview"}
        </Button>
      </div>

      {on && (
        <div className="space-y-2">
          <div className="relative aspect-video overflow-hidden rounded-md border bg-black">
            <canvas ref={canvasRef} className="h-full w-full object-contain" />
            {suspended ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">Camera open in Adjust camera…</div>
            ) : (
              (starting || !hdr) &&
              !error && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-300">
                  <Loader2 className="h-4 w-4 animate-spin" /> Opening camera…
                </div>
              )
            )}
            {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-400">{error}</div>}
            {hdr && !suspended && (
              <div className="tabular absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-slate-200">
                {hdr.sourceWidth}×{hdr.sourceHeight}
                {hdr.pixelFormat ? ` ${hdr.pixelFormat}` : ""}
                {hdr.cameraFps ? ` · ${hdr.cameraFps.toFixed(0)} fps` : ""}
              </div>
            )}
          </div>

          {hdr?.warning && (
            <p className="flex gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {hdr.warning}
            </p>
          )}
          {dark && (
            <p className="flex gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Picture is too dark — add light or remove the lens cap.
            </p>
          )}

          {sharp != null && (
            <div className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Focus — turn the lens until the bar is full</span>
                <span className="tabular font-medium">
                  {sharp.toFixed(0)} <span className="text-muted-foreground">/ best {peak.toFixed(0)}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <FocusBar pct={pct} />
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Reset best focus" onClick={resetPeak}>
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FocusBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted-foreground/25">
      <div className={cn("h-full transition-all", pct >= 90 ? "bg-emerald-500" : pct >= 70 ? "bg-amber-500" : "bg-red-500")} style={{ width: `${pct}%` }} />
    </div>
  );
}
