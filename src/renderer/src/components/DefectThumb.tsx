import { ImageOff } from "lucide-react";
import type { DefectEntry } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { cn } from "@/lib/utils";

/** Defect snapshot thumbnail, or a placeholder when the image was removed (retention / low disk). */
export function DefectThumb({ defect, className, size = "thumb" }: { defect: DefectEntry; className?: string; size?: "thumb" | "full" }) {
  const { client } = useStation();
  if (defect.hasImage === false || !client) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-1 bg-muted text-[10px] text-muted-foreground", className)} title="Snapshot removed to save disk space">
        <ImageOff className="h-4 w-4" />
        Snapshot removed
      </div>
    );
  }
  return <img src={client.defectImageUrl(defect.runId, defect.id, size)} alt="" className={cn("object-cover", className)} loading="lazy" />;
}
