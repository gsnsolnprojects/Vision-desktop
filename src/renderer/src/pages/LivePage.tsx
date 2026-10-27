import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, BarChart3, Loader2, Maximize, Square, VideoOff } from "lucide-react";
import { AnalyticsView } from "@/components/AnalyticsView";
import { RunFinishedDialog } from "@/components/RunFinishedDialog";
import { DefectThumb } from "@/components/DefectThumb";
import { LiveCanvas } from "@/components/LiveCanvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { DefectEntry, LiveSettings, RunRecord, Verdict } from "@/lib/engine";
import { loadDisplay, saveDisplay, type DisplaySettings } from "@/lib/presets";
import { useStation } from "@/lib/station";
import { cn, errorMessage, formatDuration } from "@/lib/utils";
import type { Page } from "@/App";

const RECENT_DEFECTS = 30;

const VERDICT_STYLE: Record<Verdict, { label: string; cls: string }> = {
  OK: { label: "OK", cls: "bg-emerald-600 text-white" },
  NOT_OK: { label: "NOT OK", cls: "bg-red-600 text-white" },
  NO_PRODUCT: { label: "NO PRODUCT", cls: "bg-slate-700 text-slate-200" },
};

export function LivePage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { client, status, header, streamConnected, subscribeDefects, refreshStatus } = useStation();
  const run = status?.run ?? null;
  const running = status?.state === "running" && !!run;

  const [live, setLive] = useState<LiveSettings | null>(null);
  const [display, setDisplay] = useState<DisplaySettings>(() => loadDisplay());
  const [defects, setDefects] = useState<DefectEntry[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [finishedRun, setFinishedRun] = useState<RunRecord | null>(null);
  const patchTimer = useRef<number | undefined>(undefined);
  const pendingPatch = useRef<Partial<LiveSettings>>({});
  const [, setTick] = useState(0);

  // Initialise controls and the defect list from the active run.
  useEffect(() => {
    if (!run || !client) return;
    setLive(run.live);
    setLastRunId(run.id);
    void client.run(run.id).then((r) => setDefects(r.defects.slice(0, RECENT_DEFECTS))).catch(() => undefined);
  }, [run?.id, client]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => subscribeDefects((d) => setDefects((prev) => (d.runId === run?.id ? [d, ...prev].slice(0, RECENT_DEFECTS) : prev))),
    [subscribeDefects, run?.id],
  );

  // Run timer.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const updateLive = (patch: Partial<LiveSettings>) => {
    setLive((l) => (l ? { ...l, ...patch } : l));
    // Debounced and merged so a slider drag sends one update, and quick changes to different controls are all kept.
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    window.clearTimeout(patchTimer.current);
    patchTimer.current = window.setTimeout(() => {
      const toSend = pendingPatch.current;
      pendingPatch.current = {};
      client?.updateLive(toSend).catch((err) => toast.error(`Could not update setting: ${errorMessage(err)}`));
    }, 150);
  };

  const updateDisplay = (patch: Partial<DisplaySettings>) => {
    setDisplay((d) => {
      const next = { ...d, ...patch };
      saveDisplay(next);
      return next;
    });
  };

  const stop = async () => {
    if (!client) return;
    setStopping(true);
    try {
      const rec = await client.stopRun();
      await refreshStatus();
      // Ask whether to save (name/notes) or delete. The run is already safely on disk either way.
      if (rec) setFinishedRun(rec);
    } catch (err) {
      toast.error(`Could not stop run: ${errorMessage(err)}`);
    } finally {
      setStopping(false);
    }
  };

  const finishedDialog = (
    <RunFinishedDialog
      run={finishedRun}
      onClose={() => {
        setFinishedRun(null);
      }}
    />
  );

  if (!running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        {finishedDialog}
        <VideoOff className="h-12 w-12 text-muted-foreground" />
        <div>
          <p className="text-lg font-medium">No inspection running</p>
          <p className="text-sm text-muted-foreground">Set up a model and camera to start the line.</p>
          {status?.lastError && <p className="mt-2 max-w-lg text-sm text-destructive">{status.lastError}</p>}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onNavigate("setup")}>Go to Run Setup</Button>
          {lastRunId && (
            <Button variant="outline" onClick={() => onNavigate("reports")}>
              View reports
            </Button>
          )}
        </div>
      </div>
    );
  }

  const analytics = header?.analytics ?? run.analytics;
  const stats = header?.stats ?? run.stats;
  const verdict = header?.verdict ?? null;
  const goodClasses = live?.goodClasses ?? run.live.goodClasses;
  const total = analytics.totalProducts;
  const camStatus = run.camera.status;
  const health = header?.cameraHealth ?? run.camera.health;

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1 bg-black">
        <LiveCanvas
          goodClasses={goodClasses}
          centerGuideEnabled={live?.centerGuideEnabled ?? true}
          centerGuidePercent={live?.centerGuidePercent ?? 40}
          display={display}
        />
        {verdict && (live?.verdictEnabled ?? true) && (
          <div className={cn("absolute left-4 top-4 rounded-lg px-5 py-2 text-3xl font-bold tracking-wide shadow-lg", VERDICT_STYLE[verdict].cls)}>
            {VERDICT_STYLE[verdict].label}
          </div>
        )}
        <div className="tabular absolute bottom-3 left-3 flex gap-3 rounded-md bg-black/60 px-3 py-1.5 text-xs text-slate-200">
          <span>{stats.inferFps != null ? `${stats.inferFps.toFixed(1)} FPS` : "– FPS"}</span>
          <span>inference {stats.inferMs != null ? `${stats.inferMs.toFixed(1)} ms` : "–"}</span>
          <span>latency {stats.latencyMs != null ? `${stats.latencyMs.toFixed(0)} ms` : "–"}</span>
          {run.camera.resolution[0] > 0 && <span>{run.camera.resolution.join("×")}</span>}
          {stats.cameraFps != null && <span>camera {stats.cameraFps.toFixed(0)} fps</span>}
          {status?.gpu.live && (
            <span title={status.gpu.name ?? undefined}>
              GPU {status.gpu.live.utilization}% · {status.gpu.live.temperatureC}°C
            </span>
          )}
          {status && !status.gpu.cuda && <span className="text-amber-400">running on CPU</span>}
        </div>
        {camStatus === "streaming" && streamConnected && (health?.dark || health?.slow) && (
          <div role="alert" className="absolute left-4 top-24 flex max-w-md items-start gap-2 rounded-lg bg-amber-500/95 px-4 py-2 text-sm text-black shadow-lg">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                {health.dark ? "Camera picture is too dark" : `Camera is slow (${stats.cameraFps?.toFixed(0) ?? "?"} fps)`}
              </p>
              <p className="text-xs">
                {health.dark
                  ? "Check the lighting and that the lens isn't covered. Dark images give unreliable results."
                  : "Usually caused by low light (long exposure) or a USB bandwidth issue. Improve the lighting or try another USB port."}
              </p>
            </div>
          </div>
        )}
        {(camStatus !== "streaming" || !streamConnected) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="flex items-center gap-3 rounded-lg bg-amber-500/90 px-5 py-3 text-black">
              {camStatus === "reconnecting" ? <AlertTriangle className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
              <div>
                <p className="font-semibold">{!streamConnected ? "Reconnecting to engine…" : camStatus === "reconnecting" ? "Camera disconnected — reconnecting…" : "Connecting camera…"}</p>
                {run.camera.error && <p className="text-xs">{run.camera.error}</p>}
              </div>
            </div>
          </div>
        )}
        <Button size="icon" variant="ghost" className="absolute right-3 top-3 text-white hover:bg-white/10" onClick={() => void window.station.app.toggleFullscreen()} title="Fullscreen (F11)">
          <Maximize className="h-4 w-4" />
        </Button>
      </div>

      <aside className="flex w-96 shrink-0 flex-col border-l">
        <div className="grid grid-cols-2 gap-2 border-b p-4">
          <Counter label="Total" value={total} />
          <Counter label="Defect rate" value={`${total ? ((analytics.badProducts / total) * 100).toFixed(1) : "0.0"}%`} className="text-amber-500" />
          <Counter label="Good" value={analytics.goodProducts} className="text-emerald-500" />
          <Counter label="Bad" value={analytics.badProducts} className="text-red-500" />
          <p className="col-span-2 text-xs text-muted-foreground">
            {status?.model?.name} · running {formatDuration(run.startedAt)}
          </p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {live && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-xs">Confidence</Label>
                  <span className="tabular text-xs text-muted-foreground">{Math.round(live.confidence * 100)}%</span>
                </div>
                <Slider min={5} max={95} step={1} value={[Math.round(live.confidence * 100)]} onValueChange={([v]) => updateLive({ confidence: v / 100 })} />
              </div>
              <Row label="Centre guide" checked={live.centerGuideEnabled} onChange={(v) => updateLive({ centerGuideEnabled: v })} />
              {live.centerGuideEnabled && (
                <Slider min={40} max={95} step={1} value={[live.centerGuidePercent]} onValueChange={([v]) => updateLive({ centerGuidePercent: v })} />
              )}
              <Row label="Defect logging" checked={live.defectLoggingEnabled} disabled={!live.verdictEnabled} onChange={(v) => updateLive({ defectLoggingEnabled: v })} />
              <Row label="Boxes" checked={display.showBoxes} onChange={(v) => updateDisplay({ showBoxes: v })} />
              <Row label="Polygons" checked={display.showPolygons} onChange={(v) => updateDisplay({ showPolygons: v })} />
              <Row label="Labels" checked={display.showLabels} onChange={(v) => updateDisplay({ showLabels: v })} />
            </div>
          )}

          <div className="border-t pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Defect log</p>
              <span className="text-xs text-muted-foreground">{header?.defectCount ?? defects.length} logged</span>
            </div>
            {defects.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">NOT OK products will appear here.</p>
            ) : (
              <div className="space-y-2">
                {defects.map((d) => (
                  <div key={d.id} className="flex gap-3 rounded-md border p-2">
                    <DefectThumb defect={d} className="h-14 w-24 shrink-0 rounded" />
                    <div className="min-w-0 text-xs">
                      <p className="font-medium text-red-500">NOT OK</p>
                      <p className="truncate">{d.defectClasses.join(", ")}</p>
                      <p className="text-muted-foreground">{new Date(d.timestamp).toLocaleTimeString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t p-4">
          <Button variant="outline" onClick={() => setShowAnalytics(true)}>
            <BarChart3 className="mr-2 h-4 w-4" /> Analytics
          </Button>
          <Button variant="destructive" onClick={() => void stop()} disabled={stopping}>
            {stopping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            Stop run
          </Button>
        </div>
      </aside>

      <Dialog open={showAnalytics} onOpenChange={setShowAnalytics}>
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Run Analytics</DialogTitle>
            <DialogDescription>Live summary of the current run.</DialogDescription>
          </DialogHeader>
          <AnalyticsView analytics={analytics} goodClasses={goodClasses} startedAt={run.startedAt} endedAt={null} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Counter({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-2xl font-semibold", className)}>{value}</p>
    </div>
  );
}

function Row({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between", disabled && "opacity-50")}>
      <Label className="text-sm font-normal">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
