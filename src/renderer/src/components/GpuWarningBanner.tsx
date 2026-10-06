import { AlertTriangle } from "lucide-react";
import { useStation } from "@/lib/station";

/** Loud, persistent warning when inference would run on the CPU instead of an NVIDIA GPU. */
export function GpuWarningBanner() {
  const { status } = useStation();
  if (!status || status.gpu.cuda) return null;
  return (
    <div role="alert" className="flex items-center gap-3 border-b bg-amber-500/15 px-4 py-2 text-sm text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">No NVIDIA GPU found — inspection will be slow.</span> Install or update the NVIDIA driver, then restart
        the app. Details in Settings → GPU.
      </span>
    </div>
  );
}
