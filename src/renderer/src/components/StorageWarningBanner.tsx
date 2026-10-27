import { HardDrive } from "lucide-react";
import { useStation } from "@/lib/station";

/** Shown when the disk is low or full, so operators notice before snapshots stop. */
export function StorageWarningBanner() {
  const { status } = useStation();
  const s = status?.storage;
  if (!s || !s.lowDisk) return null;
  const paused = s.snapshotsPaused;
  return (
    <div role="alert" className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${paused ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-400"}`}>
      <HardDrive className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">{paused ? "Disk almost full — defect snapshots paused." : "Low disk space."}</span>{" "}
        {paused ? "Inspection and counting continue. Free up space on this PC." : "Oldest snapshots are being removed automatically. Details in Settings → Storage."}
      </span>
    </div>
  );
}
