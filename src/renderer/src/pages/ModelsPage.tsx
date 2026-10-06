import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CloudDownload, FolderOpen, HardDrive, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { listLibraryModels, type LibraryModel } from "@/lib/backend";
import type { DownloadJob, StationModel } from "@/lib/engine";
import { useStation } from "@/lib/station";
import { supabase } from "@/lib/supabase";
import { errorMessage, formatBytes, formatDateTime } from "@/lib/utils";
import type { Page } from "@/App";

export const SELECTED_MODEL_KEY = "station.selectedModelId";

interface Project {
  id: string;
  name: string;
}

export function ModelsPage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { client, status } = useStation();
  const { profile, backendHeaders } = useAuth();
  const [local, setLocal] = useState<StationModel[]>([]);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [importing, setImporting] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>(() => localStorage.getItem("station.libraryProject") ?? "");
  const [library, setLibrary] = useState<LibraryModel[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const finishedJobs = useRef(new Set<string>());

  const project = projects.find((p) => p.id === projectId) ?? null;
  const activeModelId = status?.state === "running" ? status.model?.id : null;

  const refreshLocal = useCallback(async () => {
    if (!client) return;
    setLoadingLocal(true);
    try {
      setLocal(await client.models());
    } catch (err) {
      toast.error(`Could not list station models: ${errorMessage(err)}`);
    } finally {
      setLoadingLocal(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);

  // Projects of the user's workspace (same source as the web app).
  useEffect(() => {
    if (!profile?.companyId) return;
    void supabase
      .from("projects")
      .select("id, name")
      .eq("company_id", profile.companyId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          setLibraryError(`Could not load projects: ${error.message}`);
          return;
        }
        setProjects(data ?? []);
        if (data?.length && !data.some((p) => p.id === projectId)) setProjectId(data[0].id);
      });
  }, [profile?.companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLibrary = useCallback(async () => {
    if (!project || !profile?.company) return;
    localStorage.setItem("station.libraryProject", project.id);
    setLoadingLibrary(true);
    setLibraryError(null);
    try {
      setLibrary(await listLibraryModels(backendHeaders(), profile.company, project.name));
    } catch (err) {
      setLibrary([]);
      setLibraryError(errorMessage(err));
    } finally {
      setLoadingLibrary(false);
    }
  }, [project, profile?.company, backendHeaders]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // Poll running downloads.
  useEffect(() => {
    const running = Object.values(jobs).filter((j) => j.status === "running");
    if (!client || running.length === 0) return;
    const t = window.setInterval(async () => {
      for (const j of running) {
        try {
          const next = await client.downloadStatus(j.id);
          if (finishedJobs.current.has(next.id)) continue;
          setJobs((prev) => ({ ...prev, [next.modelId]: next }));
          if (next.status !== "running") finishedJobs.current.add(next.id);
          if (next.status === "done") {
            toast.success("Model downloaded and ready on this station");
            void refreshLocal();
          } else if (next.status === "failed") {
            toast.error(`Download failed: ${next.error}`);
          }
        } catch {
          /* engine restarting */
        }
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [client, jobs, refreshLocal]);

  const onStation = useMemo(() => new Set(local.map((m) => m.backendModelId).filter(Boolean)), [local]);

  const download = async (m: LibraryModel) => {
    if (!client || !project) return;
    try {
      const job = await client.downloadModel({
        modelId: m.modelId,
        name: m.name,
        modelType: m.modelType,
        modelVersion: m.modelVersion,
        classNames: m.classNames,
        metrics: m.metrics,
        company: profile?.company,
        project: project.name,
        projectId: project.id,
      });
      setJobs((prev) => ({ ...prev, [job.modelId]: job }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const importFile = async () => {
    if (!client) return;
    const path = await window.station.dialog.openModelFile();
    if (!path) return;
    setImporting(true);
    try {
      const m = await client.importModel(path);
      toast.success(`Loaded ${m.name}`, { description: m.classNames.length ? `Classes: ${m.classNames.join(", ")}` : undefined });
      await refreshLocal();
    } catch (err) {
      toast.error(`Could not load model: ${errorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const remove = async (m: StationModel) => {
    if (!client) return;
    if (!window.confirm(`Remove "${m.name}" from this station? Past reports are kept.`)) return;
    try {
      await client.deleteModel(m.id);
      await refreshLocal();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const use = (m: StationModel) => {
    localStorage.setItem(SELECTED_MODEL_KEY, m.id);
    onNavigate("setup");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Models</h1>
          <p className="text-sm text-muted-foreground">Models on this station run fully on the local GPU, even without internet.</p>
        </div>
        <Button onClick={importFile} disabled={!client || importing}>
          {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}
          Load from file
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4" /> On this station
            </CardTitle>
            <CardDescription>Ready to run. Library models upload their reports to Vision-M Studio; file models stay local.</CardDescription>
          </div>
          <Button size="icon" variant="ghost" onClick={() => void refreshLocal()} disabled={loadingLocal}>
            <RefreshCw className={`h-4 w-4 ${loadingLocal ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {local.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No models yet. Download one from the library below, or load a .pt / .pth / .onnx file.
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {local.map((m) => (
                <div key={m.id} className="flex items-center gap-4 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{m.name}</p>
                      <Badge variant="secondary">{m.modelType}</Badge>
                      <Badge variant={m.source === "library" ? "default" : "outline"}>{m.source === "library" ? "Library" : "File"}</Badge>
                      {activeModelId === m.id && <Badge className="bg-red-600">Running</Badge>}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {m.project ? `${m.project} · ` : ""}
                      {m.classNames.length ? `${m.classNames.length} classes: ${m.classNames.join(", ")}` : "Classes detected on first run"} ·{" "}
                      {formatBytes(m.sizeBytes)} · added {formatDateTime(m.importedAt)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => use(m)}>
                    <Play className="mr-1.5 h-3.5 w-3.5" /> Use
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => void remove(m)} disabled={activeModelId === m.id} title="Remove from station">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CloudDownload className="h-4 w-4" /> Model library
            </CardTitle>
            <CardDescription>Trained models from Vision-M Studio for your workspace.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="icon" variant="ghost" onClick={() => void refreshLibrary()} disabled={loadingLibrary || !project}>
              <RefreshCw className={`h-4 w-4 ${loadingLibrary ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {libraryError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{libraryError}</p>
          ) : loadingLibrary ? (
            <div className="flex justify-center p-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : library.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {project ? "No trained models in this project yet." : "Select a project."}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {library.map((m) => {
                const job = jobs[m.modelId];
                const have = onStation.has(m.modelId);
                const pct = job?.bytesTotal ? Math.round((job.bytesDone / job.bytesTotal) * 100) : null;
                return (
                  <div key={m.modelId} className="flex items-center gap-4 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">{m.name}</p>
                        <Badge variant="secondary">{m.modelType}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {m.metrics?.mAP50 != null ? `mAP50 ${(m.metrics.mAP50 * 100).toFixed(1)}% · ` : ""}
                        {m.classNames.length} classes · trained {formatDateTime(m.createdAt)}
                      </p>
                      {job?.status === "running" && (
                        <div className="mt-2 flex items-center gap-2">
                          <Progress value={pct ?? 0} className="h-1.5 max-w-xs" />
                          <span className="tabular text-xs text-muted-foreground">
                            {pct != null ? `${pct}%` : formatBytes(job.bytesDone)}
                          </span>
                        </div>
                      )}
                    </div>
                    {have ? (
                      <span className="flex items-center gap-1.5 text-sm text-emerald-500">
                        <CheckCircle2 className="h-4 w-4" /> On station
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => void download(m)} disabled={!client || job?.status === "running"}>
                        {job?.status === "running" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="mr-1.5 h-3.5 w-3.5" />}
                        {job?.status === "failed" ? "Retry" : "Download"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
