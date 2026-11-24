import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CameraCheckResult, StartRunRequest } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { cn, errorMessage } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  camera: StartRunRequest["camera"] | null;
}

const ICON = {
  ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />,
  error: <XCircle className="h-4 w-4 shrink-0 text-red-500" />,
};

/** Opens the camera for a few seconds with the chosen settings and shows what it really delivers. */
export function CameraCheckDialog({ open, onOpenChange, camera }: Props) {
  const { client } = useStation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CameraCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!client || !camera) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client.checkCamera(camera));
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [client, camera]);

  useEffect(() => {
    if (open) void run();
    else {
      setResult(null);
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = result?.items.filter((i) => i.status !== "ok").length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Camera check</DialogTitle>
          <DialogDescription>
            {camera
              ? `${camera.cameraName ?? camera.cameraId} · asked for ${camera.width}×${camera.height}${camera.fps ? ` @ ${camera.fps} fps` : " @ auto fps"}`
              : "Select a camera first."}
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            Opening the camera and measuring… (about 5 seconds)
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        ) : result ? (
          <div className="space-y-4">
            <div
              className={cn(
                "flex items-center gap-2 rounded-md p-3 text-sm font-medium",
                result.ok && problems === 0 && "bg-emerald-500/10 text-emerald-500",
                result.ok && problems > 0 && "bg-amber-500/10 text-amber-500",
                !result.ok && "bg-red-500/10 text-red-500",
              )}
            >
              {!result.ok ? ICON.error : problems ? ICON.warn : ICON.ok}
              {!result.ok
                ? "Camera is not ready — fix the red items below."
                : problems
                  ? "Camera works — check the amber items for a better picture."
                  : "Camera is ready."}
            </div>

            <div className="grid gap-4 md:grid-cols-[1fr_240px]">
              <div className="divide-y rounded-md border">
                {result.items.map((i) => (
                  <div key={i.key} className="flex gap-3 p-2.5 text-sm">
                    {ICON[i.status]}
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{i.label}</span>
                        <span className="text-right font-medium">{i.value}</span>
                      </div>
                      {i.tip && <p className="mt-1 text-xs text-muted-foreground">{i.tip}</p>}
                    </div>
                  </div>
                ))}
              </div>
              {result.preview && (
                <div className="space-y-1">
                  <img src={result.preview} alt="Camera snapshot" className="w-full rounded-md border" />
                  <p className="text-center text-xs text-muted-foreground">What the camera sees</p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void run()} disabled={busy || !camera}>
            <RotateCw className="mr-2 h-4 w-4" /> Check again
          </Button>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
