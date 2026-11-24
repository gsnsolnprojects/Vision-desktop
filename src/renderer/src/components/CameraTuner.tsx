import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Frame, Loader2, Lock, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FocusBar } from "@/components/CameraPreview";
import { CameraControlsList } from "@/components/CameraSettingsPanel";
import type { CameraControl, CameraControlValues, PreviewHeader, StartRunRequest } from "@/lib/engine";
import { usePreviewStream } from "@/lib/usePreviewStream";
import { cn } from "@/lib/utils";

const DARK_BELOW = 35;
const BRIGHT_ABOVE = 225;

interface Props {
  open: boolean;
  onClose(): void;
  camera: StartRunRequest["camera"] | null;
  controls: CameraControl[] | null;
  /** null = camera defaults. */
  values: CameraControlValues | null;
  /** Effective values used to open the camera (saved values or defaults). */
  effective: CameraControlValues | null;
  onChange(values: CameraControlValues | null): void;
  /** Locked preset: look only. */
  locked?: boolean;
  centerGuide: { enabled: boolean; percent: number };
}

/**
 * Full-screen camera adjustment: big live picture + every camera setting beside it.
 * Changes are applied live (the parent sends them to the camera). Done keeps them, Cancel restores
 * what was there when the view opened.
 */
export function CameraTuner({ open, onClose, camera, controls, values, effective, onChange, locked, centerGuide }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom1to1, setZoom1to1] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const snapshot = useRef<CameraControlValues | null>(null);
  const guideRef = useRef({ show: showGuide, ...centerGuide });
  guideRef.current = { show: showGuide, ...centerGuide };

  useEffect(() => {
    if (open) {
      snapshot.current = values;
      setZoom1to1(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const { hdr, error, starting, peak, resetPeak } = usePreviewStream({
    camera,
    controls: effective,
    enabled: open && !!camera,
    maxWidth: camera?.width, // full resolution, so 1:1 shows real pixels
    canvasRef,
    onDraw: drawGuide(guideRef),
  });

  // Centre the view when switching to 1:1.
  useEffect(() => {
    const el = scrollRef.current;
    if (zoom1to1 && el) {
      requestAnimationFrame(() => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
        el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      });
    }
  }, [zoom1to1, hdr?.width]);

  const cancel = () => {
    onChange(snapshot.current);
    onClose();
  };

  const sharp = hdr?.sharpness ?? null;
  const pct = sharp != null && peak > 0 ? Math.min(100, (sharp / peak) * 100) : 0;
  const bright = hdr?.brightness ?? null;
  const brightState = bright == null ? null : bright < DARK_BELOW ? "dark" : bright > BRIGHT_ABOVE ? "bright" : "ok";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="left-0 top-0 block h-screen w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:rounded-none">
        <div className="flex h-full">
          {/* Big live picture */}
          <div className="relative min-w-0 flex-1 bg-black">
            <div ref={scrollRef} className={cn("h-full w-full", zoom1to1 ? "overflow-auto" : "overflow-hidden")}>
              <div className={cn(zoom1to1 ? "flex min-h-full min-w-full items-center justify-center" : "h-full w-full")}>
                <canvas
                  ref={canvasRef}
                  className={cn(zoom1to1 ? "block" : "h-full w-full object-contain")}
                  style={zoom1to1 && hdr ? { width: hdr.width, height: hdr.height } : undefined}
                />
              </div>
            </div>

            {(starting || !hdr) && !error && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-slate-300">
                <Loader2 className="h-5 w-5 animate-spin" /> Opening camera at full resolution…
              </div>
            )}
            {error && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-red-400">{error}</div>}

            <div className="absolute right-3 top-3 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowGuide((v) => !v)} title="Show / hide the centre guide">
                <Frame className="mr-1.5 h-3.5 w-3.5" /> {showGuide ? "Hide guide" : "Show guide"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setZoom1to1((v) => !v)} title="Real pixels (1:1) to check focus and fine detail">
                {zoom1to1 ? <ZoomOut className="mr-1.5 h-3.5 w-3.5" /> : <ZoomIn className="mr-1.5 h-3.5 w-3.5" />}
                {zoom1to1 ? "Fit to screen" : "Zoom 1:1"}
              </Button>
            </div>

            {hdr && (
              <div className="tabular absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-md bg-black/70 px-3 py-1.5 text-xs text-slate-200">
                <span>
                  {hdr.sourceWidth}×{hdr.sourceHeight}
                  {hdr.pixelFormat ? ` ${hdr.pixelFormat}` : ""}
                </span>
                {hdr.cameraFps != null && <span>{hdr.cameraFps.toFixed(0)} fps</span>}
                {bright != null && <span>brightness {bright.toFixed(0)}/255</span>}
                {sharp != null && <span>focus {sharp.toFixed(0)}</span>}
                {zoom1to1 && <span className="text-sky-300">1:1 — scroll to move around</span>}
              </div>
            )}
          </div>

          {/* Settings */}
          <aside className="flex w-[380px] shrink-0 flex-col border-l bg-background">
            <div className="border-b p-4">
              <DialogTitle className="text-base">Adjust camera</DialogTitle>
              <DialogDescription className="truncate text-xs">{camera?.cameraName ?? camera?.cameraId}</DialogDescription>
              {locked && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-500">
                  <Lock className="h-3 w-3" /> Preset locked — close and click Edit to change settings.
                </p>
              )}
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Focus</span>
                  <span className="tabular text-xs">
                    {sharp != null ? sharp.toFixed(0) : "–"} <span className="text-muted-foreground">/ best {peak.toFixed(0)}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <FocusBar pct={pct} />
                  <Button size="icon" variant="ghost" className="h-6 w-6" title="Reset best focus" onClick={resetPeak}>
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">Put the product in view and turn the lens until the bar is full and green.</p>
              </div>

              {brightState && brightState !== "ok" && (
                <p className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {brightState === "dark"
                    ? "Too dark — raise exposure or gain, add light, or remove the lens cap."
                    : "Too bright — lower exposure or gain, or reduce glare."}
                </p>
              )}
              {hdr?.warning && (
                <p className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {hdr.warning}
                </p>
              )}

              {controls ? (
                <CameraControlsList controls={controls} values={values} onChange={onChange} disabled={locked} compactHelp={false} />
              ) : (
                <p className="text-sm text-muted-foreground">This camera doesn't offer adjustable image settings.</p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t p-4">
              <Button variant="outline" onClick={cancel} disabled={locked} title="Put back the settings you had when this opened">
                Cancel
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Dashed centre guide in image coordinates — products must be fully inside it to be counted. */
function drawGuide(ref: { current: { show: boolean; enabled: boolean; percent: number } }) {
  return (ctx: CanvasRenderingContext2D, header: PreviewHeader) => {
    const g = ref.current;
    if (!g.show || !g.enabled) return;
    const r = Math.min(Math.max(g.percent, 40), 95) / 100;
    const m = (1 - r) / 2;
    const lw = Math.max(2, Math.round(header.width / 640));
    ctx.save();
    ctx.setLineDash([lw * 6, lw * 5]);
    ctx.lineWidth = lw;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.strokeRect(header.width * m, header.height * m, header.width * r, header.height * r);
    ctx.restore();
  };
}
