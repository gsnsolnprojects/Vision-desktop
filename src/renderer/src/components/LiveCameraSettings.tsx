import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraControlsList, controlDefaults } from "@/components/CameraSettingsPanel";
import type { CameraControl, CameraControlValues } from "@/lib/engine";
import { listPresets, updatePreset } from "@/lib/presets";
import { useStation } from "@/lib/station";
import { cn, errorMessage } from "@/lib/utils";

const OPEN_KEY = "station.live.cameraSettingsOpen";

interface Props {
  runId: string;
  cameraId: string;
  /** Preset the run was started from, if any (offers "Save to preset"). */
  presetName: string | null;
}

/**
 * Camera settings while the inspection is running. Changes go straight to the camera, so the
 * effect (and the AI result) shows immediately. They apply to this run; "Save to preset" keeps them.
 */
export function LiveCameraSettings({ runId, cameraId, presetName }: Props) {
  const { client } = useStation();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [controls, setControls] = useState<CameraControl[] | null>(null);
  const [values, setValues] = useState<CameraControlValues | null>(null);
  const [changed, setChanged] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // Read what the camera is set to right now (the run applied the preset's settings when it started).
  useEffect(() => {
    if (!client) return;
    let alive = true;
    setControls(null);
    setValues(null);
    setChanged(false);
    void client
      .cameraControls(cameraId)
      .then((list) => {
        if (!alive || !list || list.length === 0) return;
        setControls(list);
        setValues(Object.fromEntries(list.map((c) => [c.key, { value: c.value, auto: c.auto }])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, cameraId, runId]);

  const change = (next: CameraControlValues | null) => {
    const v = next ?? (controls ? controlDefaults(controls) : null);
    if (!v || !client) return;
    setValues(v);
    setChanged(true);
    window.clearTimeout(timer.current);
    // Debounced so a slider drag sends one change, not dozens.
    timer.current = window.setTimeout(() => {
      client.applyCameraControls(cameraId, v).catch((err) => toast.error(`Camera setting not applied: ${errorMessage(err)}`));
    }, 150);
  };

  const saveToPreset = () => {
    if (!presetName || !values) return;
    const preset = listPresets().find((p) => p.name === presetName);
    if (!preset) {
      toast.error(`Preset "${presetName}" no longer exists`);
      return;
    }
    if (!window.confirm(`Save these camera settings into preset "${presetName}"? The next run from this preset will use them.`)) return;
    try {
      const { id, name, updatedAt: _u, ...cfg } = preset;
      updatePreset(id, name, { ...cfg, cameraControls: values });
      setChanged(false);
      toast.success(`Camera settings saved to "${presetName}"`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!controls) return null;

  return (
    <div className="border-t pt-4">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
        onClick={() =>
          setOpen((o) => {
            localStorage.setItem(OPEN_KEY, o ? "0" : "1");
            return !o;
          })
        }
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" /> Camera settings
          {changed && <span className="text-xs font-normal text-amber-500">changed</span>}
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <CameraControlsList controls={controls} values={values} onChange={change} compactHelp footerNote="Applies to this run right away." />
          {presetName ? (
            <Button size="sm" variant="outline" className="w-full" onClick={saveToPreset} disabled={!changed}>
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save to preset "{presetName}"
            </Button>
          ) : (
            changed && <p className="text-xs text-muted-foreground">Started without a preset: these settings are kept for this run only.</p>
          )}
        </div>
      )}
    </div>
  );
}
