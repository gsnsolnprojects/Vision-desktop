import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RunRecord } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { errorMessage, formatDuration } from "@/lib/utils";

const NAME_MAX = 120;
const NOTES_MAX = 2000;

interface Props {
  run: RunRecord | null;
  onClose(): void;
}

/**
 * Shown after a run stops: save it (with an optional name and notes) or delete it.
 * Closing without choosing keeps the run — production data is never lost by accident.
 */
export function RunFinishedDialog({ run, onClose }: Props) {
  const { client } = useStation();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);

  useEffect(() => {
    setName(run?.name ?? "");
    setNotes(run?.notes ?? "");
    setConfirmDelete(false);
    setBusy(null);
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!run) return null;
  const a = run.analytics;
  const total = a.totalProducts ?? 0;
  const bad = a.badProducts ?? 0;

  const keepAndClose = () => {
    if (busy) return;
    toast("Run kept in Reports");
    onClose();
  };

  const save = async () => {
    if (!client) return;
    setBusy("save");
    try {
      if (name.trim() || notes.trim()) await client.updateRunMeta(run.id, { name, notes });
      toast.success(name.trim() ? `Saved "${name.trim()}"` : "Run saved", { description: "Find it any time in Reports." });
      onClose();
    } catch (err) {
      toast.error(`Could not save: ${errorMessage(err)}`);
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!client) return;
    setBusy("delete");
    try {
      await client.deleteRun(run.id);
      toast.success("Run deleted");
      onClose();
    } catch (err) {
      toast.error(`Could not delete: ${errorMessage(err)}`);
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && keepAndClose()}>
      <DialogContent className="max-w-lg" onPointerDownOutside={(e) => e.preventDefault()}>
        {confirmDelete ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" /> Delete this run?
              </DialogTitle>
              <DialogDescription>
                This permanently removes the run, its counts and {run.defectCount} defect snapshot{run.defectCount === 1 ? "" : "s"} from this PC. It
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={!!busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={!!busy}>
                {busy === "delete" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Yes, delete permanently
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Run finished</DialogTitle>
              <DialogDescription>
                {run.model.name} · {formatDuration(run.startedAt, run.endedAt)}. Save it to keep it in Reports, or delete it.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-5 gap-2 text-center">
              <Summary label="Total" value={total} />
              <Summary label="Good" value={a.goodProducts ?? 0} className="text-emerald-500" />
              <Summary label="Bad" value={bad} className="text-red-500" />
              <Summary label="Defect rate" value={`${total ? ((bad / total) * 100).toFixed(1) : "0.0"}%`} className="text-amber-500" />
              <Summary label="Snapshots" value={run.defectCount} />
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label htmlFor="run-name">Run name (optional)</Label>
                  <span className="text-xs text-muted-foreground">
                    {name.length}/{NAME_MAX}
                  </span>
                </div>
                <Input
                  id="run-name"
                  autoFocus
                  maxLength={NAME_MAX}
                  placeholder="e.g. Morning shift – Line 1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label htmlFor="run-notes">Notes (optional)</Label>
                  <span className="text-xs text-muted-foreground">
                    {notes.length}/{NOTES_MAX}
                  </span>
                </div>
                <textarea
                  id="run-notes"
                  maxLength={NOTES_MAX}
                  rows={3}
                  placeholder="Batch number, issues seen, camera position…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>

            <DialogFooter className="gap-2 sm:justify-between sm:gap-0">
              <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={!!busy}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete run
              </Button>
              <Button onClick={() => void save()} disabled={!!busy}>
                {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save run
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Summary({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`tabular text-lg font-semibold ${className ?? ""}`}>{value}</p>
    </div>
  );
}
