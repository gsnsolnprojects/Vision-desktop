import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, CloudOff, CloudUpload, Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { AnalyticsView } from "@/components/AnalyticsView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { DefectEntry, RunRecord } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { errorMessage, formatDateTime, formatDuration } from "@/lib/utils";

export function ReportsPage() {
  const { client, status } = useStation();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      setRuns(await client.runs());
    } catch (err) {
      toast.error(`Could not load runs: ${errorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, status?.state]);

  if (selected) return <RunDetail runId={selected} onBack={() => { setSelected(null); void refresh(); }} />;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Every run is saved on this PC.
            {status?.sync.enabled
              ? status.sync.pendingRuns > 0 && <span className="text-amber-500"> {status.sync.pendingRuns} waiting to upload.</span>
              : " Uploading to Vision-M Studio is off (Settings)."}
          </p>
        </div>
        <div className="flex gap-2">
          {status && status.sync.enabled && status.sync.pendingRuns > 0 && (
            <Button variant="outline" onClick={() => void client?.syncNow()}>
              <CloudUpload className="mr-2 h-4 w-4" /> Upload now
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{loading ? "Loading…" : "No runs yet."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="p-3 font-medium">Started</th>
                  <th className="p-3 font-medium">Run</th>
                  <th className="p-3 font-medium">Duration</th>
                  <th className="p-3 text-right font-medium">Products</th>
                  <th className="p-3 text-right font-medium">Good</th>
                  <th className="p-3 text-right font-medium">Bad</th>
                  <th className="p-3 text-right font-medium">Defect rate</th>
                  <th className="p-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const t = r.analytics.totalProducts ?? 0;
                  const b = r.analytics.badProducts ?? 0;
                  return (
                    <tr key={r.id} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/50" onClick={() => setSelected(r.id)}>
                      <td className="p-3">{formatDateTime(r.startedAt)}</td>
                      <td className="max-w-64 p-3">
                        <p className="truncate font-medium" title={r.name ?? undefined}>{r.name || r.model.name}</p>
                        {r.name && <p className="truncate text-xs text-muted-foreground">{r.model.name}</p>}
                      </td>
                      <td className="p-3">{formatDuration(r.startedAt, r.endedAt)}</td>
                      <td className="tabular p-3 text-right">{t}</td>
                      <td className="tabular p-3 text-right text-emerald-500">{r.analytics.goodProducts ?? 0}</td>
                      <td className="tabular p-3 text-right text-red-500">{b}</td>
                      <td className="tabular p-3 text-right">{t ? ((b / t) * 100).toFixed(1) : "0.0"}%</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <RunStatusBadge status={r.status} />
                          <SyncIcon run={r} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RunStatusBadge({ status }: { status: RunRecord["status"] }) {
  if (status === "running") return <Badge className="bg-red-600">Live</Badge>;
  if (status === "interrupted") return <Badge variant="outline" className="border-amber-500 text-amber-500">Interrupted</Badge>;
  return <Badge variant="secondary">Completed</Badge>;
}

function SyncIcon({ run }: { run: RunRecord }) {
  const { status } = useStation();
  if (run.syncState === "pending" && status && !status.sync.enabled) return <span title="Saved on this PC (uploads are off)"><CloudOff className="h-3.5 w-3.5 text-muted-foreground" /></span>;
  if (run.syncState === "local_only") return <span title="Local only (file model)"><CloudOff className="h-3.5 w-3.5 text-muted-foreground" /></span>;
  if (run.syncState === "synced") return <span title="Uploaded to Vision-M Studio"><CloudUpload className="h-3.5 w-3.5 text-emerald-500" /></span>;
  return <span title={run.syncError ? `Upload pending: ${run.syncError}` : "Upload pending"}><CloudUpload className="h-3.5 w-3.5 text-amber-500" /></span>;
}

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { client } = useStation();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [defects, setDefects] = useState<DefectEntry[]>([]);
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<DefectEntry | null>(null);

  useEffect(() => {
    if (!client) return;
    void client
      .run(runId)
      .then((r) => {
        setRun(r.run);
        setDefects(r.defects);
      })
      .catch((err) => toast.error(errorMessage(err)));
  }, [client, runId]);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const res = await window.station.reports.saveRunReport(runId);
      if (res.saved) toast.success("Report exported", { description: res.path });
      else if (res.error) toast.error(`Export failed: ${res.error}`);
    } finally {
      setExporting(false);
    }
  };

  const remove = async () => {
    if (!client || !window.confirm("Delete this run and its defect snapshots from this station? Uploaded copies in Vision-M Studio are kept.")) return;
    try {
      await client.deleteRun(runId);
      onBack();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const goodClasses = run.config.live?.goodClasses ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={onBack}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> All runs
          </Button>
          <h1 className="text-2xl font-semibold">{run.name || run.model.name}</h1>
          {run.name && <p className="text-sm font-medium text-muted-foreground">{run.model.name}</p>}
          <p className="text-sm text-muted-foreground">
            {run.project ? `${run.project} · ` : ""}
            {run.cameraName} · {run.config.camera ? `${run.config.camera.width}×${run.config.camera.height} @ ${run.config.camera.fps ? `${run.config.camera.fps} fps` : "auto fps"}` : ""} · confidence{" "}
            {run.config.live ? Math.round(run.config.live.confidence * 100) : "–"}% · {run.config.precision?.toUpperCase()}
            {run.user?.email ? ` · ${run.user.email}` : ""}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            <SyncIcon run={run} />
            {run.stats.avgInferMs != null && <span className="text-xs text-muted-foreground">avg inference {run.stats.avgInferMs.toFixed(1)} ms</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void exportXlsx()} disabled={exporting}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Export Excel
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void remove()} disabled={run.status === "running"} title="Delete run">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {run.notes && (
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Notes</p>
          <p className="whitespace-pre-wrap text-sm">{run.notes}</p>
        </div>
      )}

      <AnalyticsView analytics={run.analytics} goodClasses={goodClasses} startedAt={run.startedAt} endedAt={run.endedAt} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Defect log ({defects.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {defects.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No NOT OK products were logged in this run.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {defects.map((d) => (
                <button key={d.id} className="overflow-hidden rounded-md border text-left hover:border-primary" onClick={() => setPreview(d)}>
                  {client && <img src={client.defectImageUrl(d.runId, d.id)} alt="" className="aspect-video w-full object-cover" loading="lazy" />}
                  <div className="p-2 text-xs">
                    <p className="truncate font-medium">{d.defectClasses.join(", ")}</p>
                    <p className="text-muted-foreground">{formatDateTime(d.timestamp)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-5xl">
          {preview && client && (
            <div className="space-y-2">
              <img src={client.defectImageUrl(preview.runId, preview.id)} alt="" className="w-full rounded-md" />
              <p className="text-sm">
                <span className="font-medium text-red-500">NOT OK</span> · {preview.defectClasses.join(", ")} · {formatDateTime(preview.timestamp)}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
