import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, CheckCircle2, Maximize2, ChevronDown, CopyPlus, ScanEye, Loader2, Lock, Pencil, Play, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import type { CameraControl, CameraControlValues, CameraInfo, CameraMode, LiveSettings, StationModel } from "@/lib/engine";
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
  type PixelFormat,
  type Precision,
  type RunPreset,
} from "@/lib/presets";
import { useStation } from "@/lib/station";
import { CameraCheckDialog } from "@/components/CameraCheckDialog";
import { CameraPreview } from "@/components/CameraPreview";
import { CameraSettingsPanel, controlDefaults, summarizeControls } from "@/components/CameraSettingsPanel";
import { CameraTuner } from "@/components/CameraTuner";
import { cn, errorMessage } from "@/lib/utils";
import { SELECTED_MODEL_KEY } from "@/pages/ModelsPage";
import type { Page } from "@/App";

const NEW_PRESET = "__new__";

/** 0 = let the engine measure and use the fastest rate the camera really sustains. */
const AUTO_FPS = 0;

// Not every camera supports every size; if it can't, the live view says what it gave instead.
const RESOLUTIONS = [
  { label: "640 × 480", w: 640, h: 480 },
  { label: "960 × 600", w: 960, h: 600 },
  { label: "1280 × 720 (HD)", w: 1280, h: 720 },
  { label: "1920 × 1080 (Full HD)", w: 1920, h: 1080 },
  { label: "1920 × 1200 (WUXGA)", w: 1920, h: 1200 },
];

const PIXEL_FORMATS: { value: PixelFormat; label: string }[] = [
  { value: "auto", label: "Auto (best for this camera)" },
  { value: "yuy2", label: "YUY2 — uncompressed, sharpest" },
  { value: "mjpg", label: "MJPG — compressed, for USB 2 webcams" },
];

const STANDARD_FPS = [15, 30, 50, 60, 80];
const ADVANCED_KEY = "station.setup.advancedOpen";

/** Frame-rate choices up to what the selected size supports (plus its exact top rate). */
function fpsChoices(maxFps: number | null): number[] {
  if (!maxFps) return STANDARD_FPS;
  const top = Math.round(maxFps);
  const list = STANDARD_FPS.filter((f) => f <= top + 0.5);
  if (!list.includes(top)) list.push(top);
  return list.sort((a, b) => a - b);
}

/**
 * Camera numbers shift when cameras are replugged or the PC restarts, so a saved camera is found
 * by name when its old number now belongs to a different camera.
 */
function resolveCameraId(cams: CameraInfo[], id: string, name?: string): string {
  const atId = cams.find((c) => c.id === id);
  if (name && atId?.name !== name) {
    const byName = cams.filter((c) => c.name === name);
    if (byName.length === 1) return byName[0].id;
  }
  return atId ? id : (cams[0]?.id ?? "");
}

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
  const [cameraId, setCameraIdRaw] = useState<string>(last?.cameraId ?? "");
  /** Name of the camera we want, so it is found again even if its number changes. */
  const wantedCameraName = useRef<string | undefined>(last?.cameraName);
  const [res, setRes] = useState({ w: last?.width ?? 1280, h: last?.height ?? 720 });
  const [fps, setFps] = useState(last?.fps ?? AUTO_FPS);
  const [pixelFormat, setPixelFormat] = useState<PixelFormat>(last?.pixelFormat ?? "auto");
  const [checkOpen, setCheckOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [precision, setPrecision] = useState<Precision>(last?.precision ?? "fp32");
  const [live, setLive] = useState<LiveSettings>(last?.live ?? DEFAULT_LIVE);
  const [display, setDisplay] = useState<DisplaySettings>(() => loadDisplay());
  const [starting, setStarting] = useState(false);
  /** Sizes / rates the selected camera really supports; null = unknown (fall back to common sizes). */
  const [modes, setModes] = useState<CameraMode[] | null>(null);
  /** Image controls the selected camera supports (null = none / unknown). */
  const [controlsList, setControlsList] = useState<CameraControl[] | null>(null);
  const [loadingControls, setLoadingControls] = useState(false);
  /** Saved control values; null = camera defaults. */
  const [cameraControls, setCameraControls] = useState<CameraControlValues | null>(last?.cameraControls ?? null);
  /** Bumped when a preset is loaded so its camera settings are re-sent even if they look unchanged. */
  const [applyNonce, setApplyNonce] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(() => localStorage.getItem(ADVANCED_KEY) === "1");

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
      setCameraIdRaw((cur) => resolveCameraId(cams, cur, wantedCameraName.current));
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
    wantedCameraName.current = p.cameraName;
    setCameraIdRaw(resolveCameraId(cameras, p.cameraId, p.cameraName));
    setRes({ w: p.width, h: p.height });
    setFps(p.fps);
    setPixelFormat(p.pixelFormat ?? "auto");
    setCameraControls(p.cameraControls ?? null);
    setApplyNonce((n) => n + 1);
    setPrecision(p.precision);
    setLive(p.live);
    setDisplay(p.display ?? DEFAULT_DISPLAY);
  };

  const camera = cameras.find((c) => c.id === cameraId);
  const setCameraId = (id: string) => {
    wantedCameraName.current = cameras.find((c) => c.id === id)?.name;
    setCameraIdRaw(id);
  };

  // Ask the camera which sizes and frame rates it really supports.
  useEffect(() => {
    setModes(null);
    if (!client || !cameraId || isRunning) return;
    let alive = true;
    void client
      .cameraModes(cameraId, camera?.name)
      .then((m) => alive && setModes(m && m.length ? m : null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, cameraId, camera?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which image controls (exposure, gain, ...) this camera has.
  useEffect(() => {
    setControlsList(null);
    if (!client || !cameraId || isRunning) return;
    let alive = true;
    setLoadingControls(true);
    void client
      .cameraControls(cameraId)
      .then((c) => alive && setControlsList(c && c.length ? c : null))
      .catch(() => undefined)
      .finally(() => alive && setLoadingControls(false));
    return () => {
      alive = false;
    };
  }, [client, cameraId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What the camera should be set to: the saved values, or its defaults. */
  const effectiveControls = useMemo(
    () => (controlsList ? { ...controlDefaults(controlsList), ...(cameraControls ?? {}) } : (cameraControls ?? null)),
    [controlsList, cameraControls],
  );
  const effectiveKey = JSON.stringify(effectiveControls);

  // Apply to the camera live (preview updates instantly). Debounced so slider drags send one change.
  useEffect(() => {
    if (!client || !cameraId || isRunning || !controlsList || !effectiveControls) return;
    const t = window.setTimeout(() => {
      client.applyCameraControls(cameraId, effectiveControls).catch((err) => toast.error(`Camera setting not applied: ${errorMessage(err)}`));
    }, 200);
    return () => window.clearTimeout(t);
  }, [client, cameraId, isRunning, controlsList, effectiveKey, applyNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedMode = modes?.find((m) => m.width === res.w && m.height === res.h) ?? null;
  const unsupportedSize = !!modes && !selectedMode;
  const fpsTooHigh = !!selectedMode && fps > 0 && fps > selectedMode.maxFps + 0.5;
  const currentConfig = () => ({
    modelId,
    cameraId,
    cameraName: camera?.name,
    width: res.w,
    height: res.h,
    fps,
    pixelFormat,
    cameraControls,
    precision,
    live,
    display,
  });

  const activePreset = presets.find((p) => p.id === activePresetId) ?? null;
  const locked = !!activePreset && !editing;
  const dirty =
    !!activePreset && editing && (presetConfigKey(currentConfig()) !== presetConfigKey(activePreset) || presetName.trim() !== activePreset.name);

  // Keep the chosen size and rate within what this camera supports (not for a locked preset — that is flagged instead).
  useEffect(() => {
    if (locked || !modes) return;
    if (unsupportedSize) setRes({ w: modes[0].width, h: modes[0].height });
    else if (fpsTooHigh) setFps(AUTO_FPS);
  }, [modes, res.w, res.h, fps, locked]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const started = await client.startRun({
        modelId: model.id,
        camera: { cameraId, cameraName: camera?.name, width: res.w, height: res.h, fps, pixelFormat, controls: effectiveControls },
        live,
        precision,
        gpuIndex: (await window.station.settings.get()).gpuIndex,
        presetName: presets.find((p) => p.id === activePresetId)?.name ?? null,
      });
      const camWarning = started.run?.camera.warning;
      if (camWarning) toast.warning("Camera is not running at the requested size", { description: camWarning, duration: 15000 });
      onNavigate("live");
    } catch (err) {
      toast.error("Could not start inspection", { description: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };

  const toggleGood = (cls: string) =>
    setLive((l) => ({ ...l, goodClasses: l.goodClasses.includes(cls) ? l.goodClasses.filter((c) => c !== cls) : [...l.goodClasses, cls] }));

  const modelDone = !!model;
  const cameraDone = !!cameraId && !unsupportedSize && !fpsTooHigh;
  const rulesDone = !live.verdictEnabled || live.goodClasses.length > 0;
  const fpsLabel = fps === AUTO_FPS ? "auto fps" : `${fps} fps`;
  const camRequest = cameraId ? { cameraId, cameraName: camera?.name, width: res.w, height: res.h, fps, pixelFormat } : null;
  const camRequestWithControls = camRequest ? { ...camRequest, controls: effectiveControls } : null;
  const controlsSummary = summarizeControls(controlsList, cameraControls);
  const toggleAdvanced = () =>
    setAdvancedOpen((v) => {
      localStorage.setItem(ADVANCED_KEY, v ? "0" : "1");
      return !v;
    });

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-6xl flex-1 space-y-5 p-6 pb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Run Setup</h1>
            <p className="text-sm text-muted-foreground">Choose a model and camera, set the rules, then start the line.</p>
          </div>

          {/* Compact preset bar */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={activePresetId || NEW_PRESET} onValueChange={selectPreset}>
              <SelectTrigger className="w-56" aria-label="Preset">
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
                className={cn("w-52", nameError && "border-destructive focus-visible:ring-destructive")}
                placeholder={activePreset ? "Preset name" : "Name to save as preset"}
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
                <Save className="mr-2 h-4 w-4" /> Save
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
                <Button variant="outline" size="icon" onClick={saveAsNew} title="Save as a new preset (keeps the original)">
                  <CopyPlus className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={cancelEditing} title="Cancel editing">
                  <X className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        {(locked || dirty || nameError) && (
          <div className="-mt-2 flex flex-wrap items-center justify-end gap-3 text-xs">
            {locked && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Lock className="h-3 w-3" /> Preset locked — click <span className="font-medium text-foreground">Edit</span> to change it.
              </span>
            )}
            {dirty && <Badge variant="outline" className="border-amber-500 text-amber-500">Unsaved changes</Badge>}
            {nameError && <span className="text-destructive">{nameError}</span>}
          </div>
        )}

        <div className={cn("grid min-w-0 gap-5 lg:grid-cols-2", locked && "[&_fieldset]:opacity-60")}>
          <div className="space-y-5">
            {/* ① Model */}
            <Card>
              <CardHeader className="pb-3">
                <StepTitle n={1} done={modelDone} title="Model" />
              </CardHeader>
              <CardContent>
                <fieldset disabled={locked} className="min-w-0 space-y-2">
                  {models.length === 0 ? (
                    <div className="flex items-center justify-between rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      No models on this station.
                      <Button size="sm" variant="outline" onClick={() => onNavigate("models")}>
                        Get a model
                      </Button>
                    </div>
                  ) : (
                    <Select value={modelId} onValueChange={setModelId}>
                      <SelectTrigger aria-label="Model">
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
                  {model && model.classNames.length > 0 && (
                    <p className="text-xs text-muted-foreground">Classes: {model.classNames.join(", ")}</p>
                  )}
                </fieldset>
              </CardContent>
            </Card>

            {/* ② Camera */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <StepTitle n={2} done={cameraDone} title="Camera" />
                  <Button size="sm" variant="ghost" onClick={() => void refreshCameras()} disabled={loadingCams || isRunning}>
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loadingCams && "animate-spin")} /> Rescan
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset disabled={locked} className="min-w-0 space-y-4">
                  <Select value={cameraId} onValueChange={setCameraId}>
                    <SelectTrigger aria-label="Camera">
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

                  <div className="space-y-2">
                    <Label>Resolution</Label>
                    <Select
                      value={`${res.w}x${res.h}`}
                      onValueChange={(v) => {
                        const [w, h] = v.split("x").map(Number);
                        setRes({ w, h });
                      }}
                    >
                      <SelectTrigger aria-label="Resolution">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {modes
                          ? [
                              ...modes.map((m) => (
                                <SelectItem key={`${m.width}x${m.height}`} value={`${m.width}x${m.height}`}>
                                  {m.width} × {m.height} · up to {Math.round(m.maxFps)} fps
                                </SelectItem>
                              )),
                              ...(unsupportedSize
                                ? [
                                    <SelectItem key="current" value={`${res.w}x${res.h}`}>
                                      {res.w} × {res.h} · not supported by this camera
                                    </SelectItem>,
                                  ]
                                : []),
                            ]
                          : RESOLUTIONS.map((r) => (
                              <SelectItem key={r.label} value={`${r.w}x${r.h}`}>
                                {r.label}
                              </SelectItem>
                            ))}
                      </SelectContent>
                    </Select>
                    {modes ? (
                      <p className="text-xs text-muted-foreground">Only sizes this camera supports are listed.</p>
                    ) : (
                      cameraId && <p className="text-xs text-muted-foreground">This camera can't list its sizes; use Check camera to confirm.</p>
                    )}
                    {locked && (unsupportedSize || fpsTooHigh) && (
                      <p className="text-xs text-amber-500">This preset asks for more than this camera supports — click Edit to fix it.</p>
                    )}
                  </div>
                </fieldset>

                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => setTunerOpen(true)}
                  disabled={!cameraId || isRunning}
                  title={isRunning ? "Stop the run to adjust the camera" : "Big live picture with all camera settings"}
                >
                  <Maximize2 className="mr-2 h-4 w-4" /> Adjust camera (full screen)
                </Button>

                <CameraSettingsPanel
                  controls={controlsList}
                  values={cameraControls}
                  onChange={setCameraControls}
                  loading={loadingControls}
                  disabled={locked || isRunning}
                />

                <CameraPreview camera={camRequest} controls={effectiveControls} disabled={isRunning} suspended={tunerOpen} />
              </CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            {/* ③ Inspection rules */}
            <Card>
              <CardHeader className="pb-3">
                <StepTitle n={3} done={rulesDone} title="Inspection rules" />
                <CardDescription>Same OK / NOT OK logic as Vision-M Studio. Can also be changed while running.</CardDescription>
              </CardHeader>
              <CardContent>
                <fieldset disabled={locked} className="min-w-0 space-y-5">
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
                          <button key={c} type="button" onClick={() => toggleGood(c)}>
                            <Badge variant={live.goodClasses.includes(c) ? "default" : "outline"} className="cursor-pointer px-3 py-1">
                              {c}
                            </Badge>
                          </button>
                        ))}
                      </div>
                      {model && model.classNames.length === 0 && <p className="text-xs text-amber-500">This model's classes will be read when it first loads.</p>}
                      {!rulesDone && <p className="text-xs text-amber-500">Select at least one product class.</p>}
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
                </fieldset>
              </CardContent>
            </Card>

            {/* Advanced (collapsed by default) */}
            <Card>
              <button type="button" onClick={toggleAdvanced} className="flex w-full items-center justify-between p-4 text-left" aria-expanded={advancedOpen}>
                <div>
                  <p className="text-sm font-semibold">Advanced settings</p>
                  <p className="text-xs text-muted-foreground">
                    {fps === AUTO_FPS ? "Auto frame rate" : `${fps} fps`} · {PIXEL_FORMATS.find((f) => f.value === pixelFormat)?.label.split(" —")[0].split(" (")[0]} format ·{" "}
                    {precision === "fp32" ? "Accurate" : precision === "fp16" ? "Fast" : "TensorRT"} · display options
                  </p>
                </div>
                <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", advancedOpen && "rotate-180")} />
              </button>
              {advancedOpen && (
                <CardContent className="pt-0">
                  <fieldset disabled={locked} className="min-w-0 space-y-5 border-t pt-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Frame rate</Label>
                        <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                          <SelectTrigger aria-label="Frame rate">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={String(AUTO_FPS)}>Auto (fastest it sustains)</SelectItem>
                            {fpsChoices(selectedMode?.maxFps ?? null).map((f) => (
                              <SelectItem key={f} value={String(f)}>
                                {f} fps
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Camera output format</Label>
                        <Select value={pixelFormat} onValueChange={(v) => setPixelFormat(v as PixelFormat)}>
                          <SelectTrigger aria-label="Camera output format">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PIXEL_FORMATS.map((f) => (
                              <SelectItem key={f.value} value={f.value}>
                                {f.label}
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

                    <div className="space-y-3">
                      <Label className="text-xs uppercase tracking-wide text-muted-foreground">Display</Label>
                      <ToggleRow label="Boxes" checked={display.showBoxes} onChange={(v) => setDisplay((d) => ({ ...d, showBoxes: v }))} />
                      <ToggleRow label="Segmentation polygons" checked={display.showPolygons} onChange={(v) => setDisplay((d) => ({ ...d, showPolygons: v }))} />
                      <ToggleRow label="Labels" checked={display.showLabels} onChange={(v) => setDisplay((d) => ({ ...d, showLabels: v }))} />
                    </div>
                  </fieldset>
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      </div>

      {/* Sticky action bar: always visible */}
      <div className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <p className="min-w-0 truncate text-sm text-muted-foreground">
            {model ? <span className="font-medium text-foreground">{model.name}</span> : "No model"}
            {" · "}
            {camera?.name ?? "No camera"} · {res.w}×{res.h} · {fpsLabel}
            {controlsSummary ? ` · ${controlsSummary}` : ""}
            {activePreset ? ` · preset "${activePreset.name}"` : ""}
            {!canRun && <span className="ml-2 text-amber-500">Your role can view reports but cannot run inspections.</span>}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setCheckOpen(true)}
              disabled={!client || !cameraId || isRunning}
              title={isRunning ? "Stop the run to check the camera" : "Check the camera with these settings before starting"}
            >
              <ScanEye className="mr-2 h-4 w-4" /> Check camera
            </Button>
            {isRunning ? (
              <Button onClick={() => onNavigate("live")}>A run is active — open Live Inspection</Button>
            ) : (
              <Button
                onClick={() => void start()}
                disabled={!canRun || !client || !modelDone || !cameraDone || !rulesDone || starting}
                className="min-w-44"
              >
                {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {starting ? "Loading model on GPU…" : "Start inspection"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <CameraTuner
        open={tunerOpen}
        onClose={() => setTunerOpen(false)}
        camera={camRequest}
        controls={controlsList}
        values={cameraControls}
        effective={effectiveControls}
        onChange={setCameraControls}
        locked={locked}
        centerGuide={{ enabled: live.centerGuideEnabled, percent: live.centerGuidePercent }}
      />

      <CameraCheckDialog open={checkOpen} onOpenChange={setCheckOpen} camera={camRequestWithControls} />
    </div>
  );
}

function StepTitle({ n, done, title }: { n: number; done: boolean; title: string }) {
  return (
    <CardTitle className="flex items-center gap-2 text-base">
      {done ? (
        <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-label="Done" />
      ) : (
        <span className="flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold text-muted-foreground">{n}</span>
      )}
      {title}
    </CardTitle>
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
