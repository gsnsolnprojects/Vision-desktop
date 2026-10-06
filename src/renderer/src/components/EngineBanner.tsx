import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStation } from "@/lib/station";

/** Shown only when the inference engine is not ready. */
export function EngineBanner() {
  const { engineInfo } = useStation();
  if (!engineInfo || engineInfo.state === "ready") return null;
  const failed = engineInfo.state === "failed";
  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${failed ? "bg-destructive/15 text-destructive" : "bg-amber-500/10 text-amber-400"}`}>
      {failed ? <AlertTriangle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
      <span className="flex-1">
        {engineInfo.state === "starting" && "Starting inference engine…"}
        {engineInfo.state === "restarting" && `Inference engine restarting${engineInfo.error ? ` (${engineInfo.error})` : ""}…`}
        {engineInfo.state === "stopped" && "Inference engine stopped."}
        {failed && (engineInfo.error ?? "Inference engine failed to start.")}
      </span>
      {(failed || engineInfo.state === "stopped") && (
        <Button size="sm" variant="outline" onClick={() => void window.station.engine.restart()}>
          <RotateCw className="mr-2 h-3.5 w-3.5" /> Restart engine
        </Button>
      )}
    </div>
  );
}
