import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Cpu, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { GpuSystemInfo } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { cn, errorMessage } from "@/lib/utils";

const POLL_MS = 2000;

/** Settings → GPU: every NVIDIA GPU on this PC, driver/CUDA versions, live health, and which one to use. */
export function GpuCard() {
  const { client, status } = useStation();
  const [info, setInfo] = useState<GpuSystemInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const running = status?.state === "running";

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setInfo(await client.gpus());
    } catch {
      /* engine restarting */
    }
  }, [client]);

  useEffect(() => {
    void window.station.settings.get().then((s) => setSelected(s.gpuIndex));
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const choose = async (index: number) => {
    try {
      const next = await window.station.settings.set({ gpuIndex: index });
      setSelected(next.gpuIndex);
      toast.success(`GPU ${index} will be used from the next run`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const usable = info?.gpus.filter((g) => g.usable !== false) ?? [];
  const effective = selected != null && usable.some((g) => g.index === selected) ? selected : (usable[0]?.index ?? null);
  const inUse = status?.gpu.index ?? null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" /> GPU
          </CardTitle>
          <CardDescription>Inference runs on an NVIDIA GPU through CUDA.</CardDescription>
        </div>
        <Button size="icon" variant="ghost" onClick={() => void refresh()} title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!info ? (
          <p className="text-muted-foreground">Reading GPU information…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <Row label="CUDA available" value={info.cuda ? "Yes" : "No"} warn={!info.cuda} />
              <Row label="NVIDIA driver" value={info.driverVersion ?? "Not installed"} warn={!info.driverVersion} />
              <Row label="CUDA version (engine)" value={info.cudaVersion ?? "-"} />
              <Row label="GPUs found" value={String(usable.length)} warn={usable.length === 0} />
            </div>

            {!info.cuda && (
              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {info.gpus.length > 0
                    ? "An NVIDIA GPU is present but CUDA can't use it — the driver is probably too old. Update the NVIDIA driver and restart the app."
                    : "No NVIDIA GPU or driver found. Inspection runs on the CPU and will be much slower."}
                </p>
              </div>
            )}

            {info.gpus.map((g) => {
              const isUsable = g.usable !== false;
              const live = g.live;
              const memPct = live ? (live.memoryUsedMb / live.memoryTotalMb) * 100 : 0;
              return (
                <div key={g.index} className={cn("rounded-md border p-3", effective === g.index && isUsable && "border-primary")}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        GPU {g.index} · {g.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(g.memoryTotalMb / 1024).toFixed(1)} GB memory{g.computeCapability ? ` · compute ${g.computeCapability}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {inUse === g.index && running && <Badge className="bg-red-600">In use</Badge>}
                      {!isUsable ? (
                        <Badge variant="outline" className="border-amber-500 text-amber-500">Not usable</Badge>
                      ) : effective === g.index ? (
                        <Badge>Selected</Badge>
                      ) : (
                        usable.length > 1 && (
                          <Button size="sm" variant="outline" onClick={() => void choose(g.index)}>
                            Use this GPU
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                  {live && (
                    <div className="mt-3 grid grid-cols-3 gap-4 text-xs">
                      <Meter label="Usage" value={`${live.utilization}%`} pct={live.utilization} />
                      <Meter label="Memory" value={`${(live.memoryUsedMb / 1024).toFixed(1)} / ${(live.memoryTotalMb / 1024).toFixed(1)} GB`} pct={memPct} />
                      <Meter
                        label="Temperature"
                        value={`${live.temperatureC}°C${live.powerW != null ? ` · ${live.powerW} W` : ""}`}
                        pct={Math.min(100, (live.temperatureC / 90) * 100)}
                        warn={live.temperatureC >= 85}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {usable.length > 1 && <p className="text-xs text-muted-foreground">The selected GPU is used from the next run you start.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right", warn && "text-amber-500")}>{value}</span>
    </div>
  );
}

function Meter({ label, value, pct, warn }: { label: string; value: string; pct: number; warn?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular", warn && "text-red-500")}>{value}</span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}
