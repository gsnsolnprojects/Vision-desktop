import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, FileText, Loader2, RotateCw, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EngineInfo, RuntimeSetup } from "../../../shared/ipc";

const STEPS: { phase: RuntimeSetup["phase"][]; label: string }[] = [
  { phase: ["checking", "creating"], label: "Prepare environment" },
  { phase: ["downloading"], label: "Download AI components (~4 GB)" },
  { phase: ["installing"], label: "Install" },
  { phase: ["verifying", "done"], label: "Check installation" },
];

/** First launch of an installed station: one-time download of PyTorch / CUDA / TensorRT. */
export function RuntimeSetupScreen({ info }: { info: EngineInfo }) {
  const setup = info.setup;
  const failed = setup?.phase === "failed" || info.state === "failed";
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!setup?.startedAt || failed) return;
    const start = new Date(setup.startedAt).getTime();
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [setup?.startedAt, failed]);

  const shownPhase = setup?.phase === "failed" ? setup.failedPhase : setup?.phase;
  const current = STEPS.findIndex((s) => shownPhase != null && s.phase.includes(shownPhase));

  return (
    <div className="flex h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.15),transparent_60%)] p-6">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ScanLine className="h-5 w-5" />
          </div>
          <CardTitle>{failed ? "AI runtime setup failed" : "Setting up AI runtime"}</CardTitle>
          <CardDescription>
            {failed
              ? "The station couldn't finish installing its AI components."
              : "First launch only: downloading the GPU inference components. Keep the app open and connected to the internet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-2">
            {STEPS.map((s, i) => {
              const done = setup?.phase === "done" || (current >= 0 && i < current);
              const active = i === current && !failed && setup?.phase !== "done";
              return (
                <li key={s.label} className="flex items-center gap-3 text-sm">
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : active ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : failed && i === current ? (
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className={cn(!done && !active && "text-muted-foreground")}>{s.label}</span>
                </li>
              );
            })}
          </ol>

          {!failed && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{setup?.detail ?? setup?.message ?? "Starting…"}</p>
              <p className="tabular text-xs text-muted-foreground">
                Elapsed {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} · usually 5–20 minutes depending on the connection
              </p>
            </div>
          )}

          {failed && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {setup?.error ?? info.error ?? "Unknown error"}
            </div>
          )}

          {setup && setup.log.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-md bg-black/60 p-2 text-[11px] leading-snug text-slate-300">
              {setup.log.slice(-12).join("\n")}
            </pre>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void window.station.app.openRuntimeLog()}>
              <FileText className="mr-2 h-4 w-4" /> Open setup log
            </Button>
            {failed && (
              <Button onClick={() => void window.station.engine.restart()}>
                <RotateCw className="mr-2 h-4 w-4" /> Retry
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
