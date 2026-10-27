import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HardDrive, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StorageStatus } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { errorMessage, formatBytes, formatDateTime } from "@/lib/utils";
import type { AppSettings } from "../../../shared/ipc";

const CHOICES: { value: AppSettings["snapshotRetentionDays"]; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: 0, label: "Forever" },
];

/** Settings → Storage: snapshot retention, disk usage and manual cleanup. */
export function StorageCard() {
  const { client } = useStation();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [days, setDays] = useState<AppSettings["snapshotRetentionDays"]>(30);
  const [cleaning, setCleaning] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setStatus(await client.storage());
    } catch {
      /* engine restarting */
    }
  }, [client]);

  useEffect(() => {
    void window.station.settings.get().then((s) => setDays(s.snapshotRetentionDays));
    void refresh();
  }, [refresh]);

  const changeRetention = async (v: string) => {
    const value = Number(v) as AppSettings["snapshotRetentionDays"];
    try {
      await window.station.settings.set({ snapshotRetentionDays: value });
      setDays(value);
      if (client) setStatus(await client.setRetention(value));
      toast.success(value === 0 ? "Snapshots will be kept forever" : `Snapshots older than ${CHOICES.find((c) => c.value === value)?.label} will be removed`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const cleanup = async () => {
    if (!client) return;
    setCleaning(true);
    try {
      const s = await client.cleanupStorage();
      setStatus(s);
      toast.success(s.lastRemoved ? `Removed ${s.lastRemoved} old snapshots (${formatBytes(s.lastFreedBytes)})` : "Nothing to clean up");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCleaning(false);
    }
  };

  const usedPct = status ? ((status.totalBytes - status.freeBytes) / status.totalBytes) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="h-4 w-4" /> Storage
        </CardTitle>
        <CardDescription>
          Defect snapshot images are removed after the period below. Runs, counts and defect lists are always kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Keep defect snapshots for</p>
            <p className="text-xs text-muted-foreground">Snapshots waiting to upload are never removed.</p>
          </div>
          <Select value={String(days)} onValueChange={(v) => void changeRetention(v)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHOICES.map((c) => (
                <SelectItem key={c.value} value={String(c.value)}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {status && (
          <>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Disk</span>
                <span className={status.lowDisk ? "text-amber-500" : ""}>
                  {formatBytes(status.freeBytes)} free of {formatBytes(status.totalBytes)}
                </span>
              </div>
              <Progress value={usedPct} className="h-1.5" />
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <span className="text-muted-foreground">Snapshots on this PC</span>
              <span className="text-right">{status.snapshotsBytes != null ? formatBytes(status.snapshotsBytes) : "…"}</span>
              <span className="text-muted-foreground">Last cleanup</span>
              <span className="text-right">
                {formatDateTime(status.lastCleanupAt)}
                {status.lastRemoved ? ` · removed ${status.lastRemoved}` : ""}
              </span>
            </div>
            {status.snapshotsPaused ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                Disk almost full: new defect snapshots are paused. Defects are still counted and logged. Free up disk space.
              </p>
            ) : (
              status.lowDisk && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-500">
                  Low disk space: the oldest snapshots are being removed automatically.
                </p>
              )
            )}
          </>
        )}

        <Button variant="outline" onClick={() => void cleanup()} disabled={cleaning || !client}>
          {cleaning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
          Clean up now
        </Button>
      </CardContent>
    </Card>
  );
}
