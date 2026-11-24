import { useState } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { CameraControl, CameraControlValues } from "@/lib/engine";
import { cn } from "@/lib/utils";

const OPEN_KEY = "station.setup.cameraSettingsOpen";

/** Short explanations so operators know what each control does. */
const HELP: Record<string, string> = {
  exposure: "How long each picture collects light. Longer = brighter but moving parts blur.",
  gain: "Electronic boost. Higher = brighter but grainier.",
  white_balance: "Colour temperature. Lock it so colours don't drift.",
  brightness: "Overall brightness offset.",
  contrast: "Difference between light and dark areas.",
  saturation: "Colour strength.",
  hue: "Colour shift.",
  sharpness: "Edge sharpening done by the camera.",
  gamma: "Mid-tone brightness.",
  backlight_compensation: "Brightens the subject against a bright background.",
  powerline_frequency: "Removes flicker from mains lighting (50 Hz in India).",
  focus: "Lens focus (cameras with a motorised lens).",
  zoom: "Digital or optical zoom.",
};

/** Camera's own defaults, auto wherever supported — used when nothing is saved. */
export function controlDefaults(controls: CameraControl[]): CameraControlValues {
  return Object.fromEntries(controls.map((c) => [c.key, { value: c.default, auto: c.autoSupported }]));
}

export function formatControl(c: CameraControl, value: number): string {
  if (c.key === "exposure") {
    // UVC exposure is log2 seconds: -11 = 1/2048 s.
    const ms = 1000 * 2 ** value;
    return ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 2)} ms`;
  }
  if (c.key === "white_balance") return `${value} K`;
  return String(value);
}

/** One-line summary for collapsed views and the bottom bar. */
export function summarizeControls(controls: CameraControl[] | null, values: CameraControlValues | null): string {
  if (!controls || controls.length === 0) return "";
  if (!values) return "camera defaults";
  const exp = controls.find((c) => c.key === "exposure");
  const v = exp ? values.exposure : undefined;
  if (exp && v) return v.auto ? "auto exposure" : `exposure ${formatControl(exp, v.value ?? exp.default)}`;
  return "custom camera settings";
}

interface Props {
  controls: CameraControl[] | null;
  /** null = camera defaults (nothing saved). */
  values: CameraControlValues | null;
  onChange(values: CameraControlValues | null): void;
  loading?: boolean;
  /** Locked preset: values visible but read-only. */
  disabled?: boolean;
}

/** Exposure, gain, white balance, ... — only what the selected camera supports. Saved with the preset. */
export function CameraSettingsPanel({ controls, values, onChange, loading, disabled }: Props) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const toggle = () =>
    setOpen((v) => {
      localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      return !v;
    });

  if (!controls && !loading) {
    return <p className="text-xs text-muted-foreground">This camera doesn't offer adjustable image settings.</p>;
  }

  return (
    <div className="rounded-md border">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-3 p-3 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <span>
            <span className="block text-sm font-medium">Camera settings</span>
            <span className="block text-xs text-muted-foreground">{loading ? "Reading camera…" : summarizeControls(controls, values)}</span>
          </span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && controls && (
        <div className="border-t p-3">
          <CameraControlsList controls={controls} values={values} onChange={onChange} disabled={disabled} />
        </div>
      )}
    </div>
  );
}

/** The sliders / auto switches for each control, plus "Camera defaults". Shared by the panel and the full-screen tuner. */
export function CameraControlsList({
  controls,
  values,
  onChange,
  disabled,
  compactHelp,
  footerNote = "Changes show live and are saved with the preset.",
}: {
  controls: CameraControl[];
  values: CameraControlValues | null;
  onChange(values: CameraControlValues | null): void;
  disabled?: boolean;
  compactHelp?: boolean;
  footerNote?: string;
}) {
  const effective = values ?? controlDefaults(controls);
  const set = (key: string, patch: Partial<{ value: number | null; auto: boolean }>) => {
    const base = values ?? controlDefaults(controls);
    onChange({ ...base, [key]: { ...base[key], ...patch } });
  };

  return (
    <div className="space-y-4">
      {controls.map((c) => {
        const v = effective[c.key] ?? { value: c.default, auto: c.autoSupported };
        const value = v.value ?? c.default;
        const auto = c.autoSupported && v.auto;
        return (
          <div key={c.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm" title={HELP[c.key]}>
                {c.label}
              </Label>
              <div className="flex items-center gap-3">
                {/* With Auto on, the switch already says so; the value only shows in manual mode. */}
                {!auto && <span className="tabular text-xs font-medium">{formatControl(c, value)}</span>}
                {c.autoSupported && (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Auto
                    <Switch checked={auto} disabled={disabled} onCheckedChange={(on) => set(c.key, { auto: on, value })} aria-label={`${c.label} auto`} />
                  </label>
                )}
              </div>
            </div>
            <Slider
              min={c.min}
              max={c.max}
              step={c.step}
              value={[value]}
              disabled={auto || disabled}
              onValueChange={([n]) => set(c.key, { value: n, auto: false })}
              aria-label={c.label}
            />
            {HELP[c.key] && !compactHelp && <p className="text-[11px] text-muted-foreground">{HELP[c.key]}</p>}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-xs text-muted-foreground">{footerNote}</p>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)} disabled={!values || disabled}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Camera defaults
        </Button>
      </div>
    </div>
  );
}
