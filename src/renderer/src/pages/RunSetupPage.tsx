import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Camera, CopyPlus, Loader2, Lock, Pencil, Play, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import type { CameraInfo, LiveSettings, StationModel } from "@/lib/engine";
import {
  DEFAULT_DISPLAY,
  DEFAULT_LIVE,
  PRESET_NAME_MAX,
  createPreset,
  deletePreset,
  listPresets,
  loadDisplay,
  loadLastConfig,
  presetConfigKey,
  saveDisplay,
  saveLastConfig,
  updatePreset,
  validatePresetName,
  type DisplaySettings,
  type Precision,
  type RunPreset,
} from "@/lib/presets";
import { useStation } from "@/lib/station";
import { cn, errorMessage } from "@/lib/utils";
import { SELECTED_MODEL_KEY } from "@/pages/ModelsPage";
import type { Page } from "@/App";

const NEW_PRESET = "__new__";

/** 0 = let the engine measure and use the fastest rate the camera really sustains. */
const AUTO_FPS = 0;

const RESOLUTIONS = [
  { label: "640 × 480", w: 640, h: 480 },
  { label: "1280 × 720 (HD)", w: 1280, h: 720 },
  { label: "1920 × 1080 (Full HD)", w: 1920, h: 1080 },
];

/** Same default as the web app: "product" if the model has it, else its first class. */
function defaultGoodClasses(names: string[]): string[] {
  if (names.includes("product")) return ["product"];
  return names.length ? [names[0]] : ["product"];
}

export function RunSetupPage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { client, status } = useStation();
  const { canRun } = useAuth();
  const last = useMemo(() => loadLastConfig(), []);

  const [models, setModels] = useState<StationModel[]>([]);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [loadingCams, setLoadingCams] = useState(false);
  const [presets, setPresets] = useState<RunPreset[]>(() => listPresets());
  const [presetName, setPresetName] = useState("");
  const [activePresetId, setActivePresetId] = useState<string>("");
  const [nameError, setNameError] = useState<string | null>(null);
  /** A loaded preset is locked (read-only) until the user clicks Edit. */
  const [editing, setEditing] = useState(false);

  const [modelId, setModelId] = useState<string>(() => localStorage.getItem(SELECTED_MODEL_KEY) ?? last?.modelId ?? "");
  const [cameraId, setCameraId] = useState<string>(last?.cameraId ?? "");
  const [res, setRes] = useState({ w: last?.width ?? 1280, h: last?.height ?? 720 });
  const [fps, setFps] = useState(last?.fps ?? AUTO_FPS);
  const [precision, setPrecision] = useState<Precision>(last?.precision ?? "fp32");
  const [live, setLive] = useState<LiveSettings>(last?.live ?? DEFAULT_LIVE);
  const [display, setDisplay] = useState<DisplaySettings>(() => loadDisplay());
  const [starting, setStarting] = useState(false);

  const model = models.find((m) => m.id === modelId) ?? null;
  const isRunning = status?.state === "running";

  useEffect(() => {
    localStorage.removeItem(SELECTED_MODEL_KEY);
  }, []);

  const refreshCameras = useCallback(async () => {
    if (!client) return;
    setLoadingCams(true);
    try {
      const cams = await client.cameras();
      setCameras(cams);
      setCameraId((cur) => (cams.some((c) => c.id === cur) ? cur : (cams[0]?.id ?? "")));
    } catch (err) {
      toast.error(`Could not list cameras: ${errorMessage(err)}`);
    } finally {
      setLoadingCams(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void client.models().then((ms) => {
      setModels(ms);
      setModelId((cur) => (ms.some((m) => m.id === cur) ? cur : (ms[0]?.id ?? "")));
    });
    void refreshCameras();
  }, [client, refreshCameras]);

  // When the model changes, keep good classes only if they exist in the new model.
  useEffect(() => {
    if (!model || model.classNames.length === 0) return;
    setLive((l) =>
      l.goodClasses.length && l.goodClasses.every((c) => model.classNames.includes(c)) ? l : { ...l, goodClasses: defaultGoodClasses(model.classNames) },
    );
  }, [model?.id, model?.classNames.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Load a preset's settings into the form (locked, read-only). */
  const loadPreset = (p: RunPreset) => {
    setActivePresetId(p.id);
    setPresetName(p.name);
    setNameError(null);
    setEditing(false);
    setModelId(p.modelId);
    setCameraId(p.cameraId);
    setRes({ w: p.width, h: p.height });
    setFps(p.fps);
    setPrecision(p.precision);
    setLive(p.live);
    setDisplay(p.display ?? DEFAULT_DISPLAY);
  };

  const camera = cameras.find((c) => c.id === cameraId);
  const currentConfig = () => ({
    modelId,
    cameraId,
    cameraName: camera?.name,
    width: res.w,
    height: res.h,
    fps,
    precision,
    live,
    display,
  });

  const activePreset = presets.find((p) => p.id === activePresetId) ?? null;
  const locked = !!activePreset && !editing;
  const dirty =
    !!activePreset && editing && (presetConfigKey(currentConfig()) !== presetConfigKey(activePreset) || presetName.trim() !== activePreset.name);

  /** Ask before throwing away unsaved preset edits. */
  const confirmDiscard = () => !dirty || window.confirm("You have unsaved changes to this preset. Discard them?");

  const newPreset = () => {
    setActivePresetId("");
    setPresetName("");
    setNameError(null);
    setEditing(false);
  };

  const selectPreset = (id: string) => {
    if (id === (activePresetId || NEW_PRESET)) return;
    if (!confirmDiscard()) return;
    if (id === NEW_PRESET) {
      newPreset();
      return;
    }
    const p = presets.find((x) => x.id === id);
    if (p) loadPreset(p);
  };

  const startEditing = () => {
    setEditing(true);
    setNameError(null);
  };

  const cancelEditing = () => {
    if (!activePreset || !confirmDiscard()) return;
    loadPreset(activePreset); // restore the saved settings and lock again
  };

  /** Create a new preset (also "Save as new" from an existing one). The new preset opens locked. */
  const saveAsNew = () => {
    try {
      const p = createPreset(presetName, currentConfig());
      setPresets(listPresets());
      setActivePresetId(p.id);
      setPresetName(p.name);
      setNameError(null);
      setEditing(false);
      toast.success(`Preset "${p.name}" saved`);
    } catch (err) {
      setNameError(errorMessage(err));
    }
  };

  const saveChanges = () => {
    if (!activePreset) return;
    try {
      const p = updatePreset(activePreset.id, presetName, currentConfig());
      setPresets(listPresets());
      setPresetName(p.name);
      setNameError(null);
      setEditing(false);
      toast.success(p.name !== activePreset.name ? `Preset renamed to "${p.name}" and saved` : `Preset "${p.name}" saved`);
    } catch (err) {
      setNameError(errorMessage(err));
    }
  };

  const removePreset = () => {
    if (!activePreset) return;
    if (!window.confirm(`Delete preset "${activePreset.name}"? This can't be undone.`)) return;
    deletePreset(activePreset.id);
    setPresets(listPresets());
    newPreset();
    toast.success(`Preset "${activePreset.name}" deleted`);
  };

  const start = async () => {
    if (!client || !model || !cameraId) return;
    if (dirty && !window.confirm("This preset has unsaved changes. Start with these settings anyway? The saved preset will not change.")) return;
    if (live.verdictEnabled && live.goodClasses.length === 0) {
      toast.error("Select at least one product (good) class");
      return;
    }
    setStarting(true);
    try {
      saveLastConfig(currentConfig());
      saveDisplay(display);
      await client.startRun({
        modelId: model.id,
        camera: { cameraId, cameraName: camera?.name, width: res.w, height: res.h, fps },
        live,
        precision,
        gpuIndex: (await window.station.settings.get()).gpuIndex,
        presetName: presets.find((p) => p.id === activePresetId)?.name ?? null,
      });
      onNavigate("live");
    } catch (err) {
      toast.error("Could not start inspection", { description: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };

  const toggleGood = (cls: string) =>
    setLive((l) => ({ ...l, goodClasses: l.goodClasses.includes(cls) ? l.goodClasses.filter((c) => c !== cls) : [...l.goodClasses, cls] }));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Run Setup</h1>
        <p className="text-sm text-muted-foreground">Choose a model, camera and inspection rules, then start the line.</p>
      </div>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="mr-1 text-sm">Preset</Label>
            <Select value={activePresetId || NEW_PRESET} onValueChange={selectPreset}>
              <SelectTrigger className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_PRESET}>+ New preset</SelectItem>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(!activePreset || editing) && (
              <Input
                className={cn("w-64", nameError && "border-destructive focus-visible:ring-destructive")}
                placeholder={activePreset ? "Preset name" : "Name for a new preset"}
                maxLength={PRESET_NAME_MAX}
                value={presetName}
                autoFocus={editing}
                aria-label="Preset name"
                aria-invalid={!!nameError}
                onChange={(e) => {
                  setPresetName(e.target.value);
                  setNameError(e.target.value.trim() ? validatePresetName(e.target.value, activePresetId || undefined) : null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (activePreset ? saveChanges : saveAsNew)();
                  if (e.key === "Escape" && editing) cancelEditing();
                }}
              />
            )}

            {!activePreset && (
              <Button variant="outline" onClick={saveAsNew}>
                <Save className="mr-2 h-4 w-4" /> Save as preset
              </Button>
            )}

            {locked && (
              <>
                <Button variant="outline" onClick={startEditing}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Button>
                <Button variant="ghost" size="icon" onClick={removePreset} title="Delete preset">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}

            {activePreset && editing && (
              <>
                <Button onClick={saveChanges} disabled={!dirty}>
                  <Save className="mr-2 h-4 w-4" /> Save changes
                </Button>
                <Button variant="outline" onClick={saveAsNew} title="Keep the original and save these settings as a new preset">
                  <CopyPlus className="mr-2 h-4 w-4" /> Save as new
                </Button>
                <Button variant="ghost" onClick={cancelEditing}>
                  <X className="mr-2 h-4 w-4" /> Cancel
                </Button>
              </>
            )}
          </div>
          <div className="flex min-h-5 items-center gap-3 text-xs">
            {locked && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Lock className="h-3 w-3" /> Preset locked — click <span className="font-medium text-foreground">Edit</span> to change it.
              </span>
            )}
            {activePreset && editing && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Pencil className="h-3 w-3" /> Editing: <span className="font-medium text-foreground">{activePreset.name}</span>
              </span>
            )}
            {dirty && <Badge variant="outline" className="border-amber-500 text-amber-500">Unsaved changes</Badge>}
            {nameError && <span className="text-destructive">{nameError}</span>}
            {!activePreset && !nameError && presets.length === 0 && (
              <span className="text-muted-foreground">Save these settings as a preset to reload them in one click.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* A native fieldset disables every input, button, select and switch inside it at once. */}
      <fieldset
        disabled={locked}
        aria-label={locked ? "Settings locked by preset" : undefined}
        className={cn("grid min-w-0 gap-6 transition-opacity lg:grid-cols-2", locked && "opacity-60")}
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Model & camera</CardTitle>
            <CardDescription>Inference runs on this station's GPU.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Model</Label>
              {models.length === 0 ? (
                <div className="flex items-center justify-between rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No models on this station.
                  <Button size="sm" variant="outline" onClick={() => onNavigate("models")}>
                    Get a model
                  </Button>
                </div>
              ) : (
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name} · {m.modelType}
                        {m.source === "file" ? " · file" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Camera</Label>
                <Button size="sm" variant="ghost" onClick={() => void refreshCameras()} disabled={loadingCams || isRunning}>
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loadingCams && "animate-spin")} /> Rescan
                </Button>
              </div>
              <Select value={cameraId} onValueChange={setCameraId}>
                <SelectTrigger>
                  <SelectValue placeholder={cameras.length ? "Select a camera" : "No cameras found"} />
                </SelectTrigger>
                <SelectContent>
                  {cameras.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="flex items-center gap-2">
                        <Camera className="h-3.5 w-3.5" /> {c.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Resolution</Label>
                <Select value={`${res.w}x${res.h}`} onValueChange={(v) => {
                  const [w, h] = v.split("x").map(Number);
                  setRes({ w, h });
                }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS.map((r) => (
                      <SelectItem key={r.label} value={`${r.w}x${r.h}`}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Frame rate</Label>
                <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={String(AUTO_FPS)}>Auto (best for this camera)</SelectItem>
                    {[15, 30, 60].map((f) => (
                      <SelectItem key={f} value={String(f)}>
                        {f} fps
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Precision</Label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["fp32", "Accurate (FP32)", "Identical results to Vision-M Studio", true],
                    ["fp16", "Fast (FP16)", "Faster on NVIDIA GPUs; tiny score differences", true],
                    [
                      "trt",
                      "Fastest (TensorRT)",
                      !model?.tensorrt?.supported
                        ? "YOLO models on an NVIDIA GPU only"
                        : model.tensorrt.ready
                          ? "About 2x faster; optimised for this GPU"
                          : "Optimize this model first (Models page)",
                      !!model?.tensorrt?.ready,
                    ],
                  ] as const
                ).map(([v, title, desc, available]) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!available}
                    onClick={() => setPrecision(v)}
                    className={cn(
                      "rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      precision === v ? "border-primary bg-primary/10" : "hover:bg-muted",
                    )}
                  >
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inspection rules</CardTitle>
            <CardDescription>Same OK / NOT OK logic as Vision-M Studio. These can also be changed while running.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label>Confidence threshold</Label>
                <span className="tabular text-sm text-muted-foreground">{Math.round(live.confidence * 100)}%</span>
              </div>
              <Slider disabled={locked} min={5} max={95} step={1} value={[Math.round(live.confidence * 100)]} onValueChange={([v]) => setLive((l) => ({ ...l, confidence: v / 100 }))} />
            </div>

            <ToggleRow label="OK / NOT OK verdict" desc="Decide each product from its detections" checked={live.verdictEnabled} onChange={(v) => setLive((l) => ({ ...l, verdictEnabled: v }))} />

            {live.verdictEnabled && (
              <div className="space-y-2">
                <Label>Product (good) classes</Label>
                <p className="text-xs text-muted-foreground">A product is detected by these classes; any other class is a defect.</p>
                <div className="flex flex-wrap gap-2">
                  {(model?.classNames.length ? model.classNames : live.goodClasses).map((c) => (
                    <button key={c} onClick={() => toggleGood(c)}>
                      <Badge variant={live.goodClasses.includes(c) ? "default" : "outline"} className="cursor-pointer px-3 py-1">
                        {c}
                      </Badge>
                    </button>
                  ))}
                </div>
                {model && model.classNames.length === 0 && (
                  <p className="text-xs text-amber-500">This model's classes will be read when it first loads.</p>
                )}
              </div>
            )}

            <ToggleRow
              label="Defect logging"
              desc="Save a snapshot for every NOT OK product"
              checked={live.verdictEnabled && live.defectLoggingEnabled}
              disabled={!live.verdictEnabled}
              onChange={(v) => setLive((l) => ({ ...l, defectLoggingEnabled: v }))}
            />
            <ToggleRow
              label="Centre guide"
              desc="Only count products fully inside the centre region"
              checked={live.centerGuideEnabled}
              onChange={(v) => setLive((l) => ({ ...l, centerGuideEnabled: v }))}
            />
            {live.centerGuideEnabled && (
              <div className="space-y-2 pl-1">
                <div className="flex justify-between">
                  <Label className="text-xs">Guide size</Label>
                  <span className="tabular text-xs text-muted-foreground">{live.centerGuidePercent}%</span>
                </div>
                <Slider disabled={locked} min={40} max={95} step={1} value={[live.centerGuidePercent]} onValueChange={([v]) => setLive((l) => ({ ...l, centerGuidePercent: v }))} />
              </div>
            )}

            <div className="space-y-3 border-t pt-4">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Display</Label>
              <ToggleRow label="Boxes" checked={display.showBoxes} onChange={(v) => setDisplay((d) => ({ ...d, showBoxes: v }))} />
              <ToggleRow label="Segmentation polygons" checked={display.showPolygons} onChange={(v) => setDisplay((d) => ({ ...d, showPolygons: v }))} />
              <ToggleRow label="Labels" checked={display.showLabels} onChange={(v) => setDisplay((d) => ({ ...d, showLabels: v }))} />
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <div className="flex items-center justify-end gap-3">
        {!canRun && <p className="text-sm text-amber-500">Your role can view reports but cannot run inspections.</p>}
        {isRunning ? (
          <Button size="lg" onClick={() => onNavigate("live")}>
            A run is active — open Live Inspection
          </Button>
        ) : (
          <Button size="lg" onClick={() => void start()} disabled={!canRun || !client || !model || !cameraId || starting} className="min-w-48">
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {starting ? "Loading model on GPU…" : "Start inspection"}
          </Button>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange, disabled }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-50")}>
      <div>
        <p className="text-sm font-medium">{label}</p>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
