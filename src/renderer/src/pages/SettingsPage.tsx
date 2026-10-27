import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, RotateCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { useStation } from "@/lib/station";
import { GpuCard } from "@/components/GpuCard";
import { StorageCard } from "@/components/StorageCard";
import { errorMessage, formatDateTime } from "@/lib/utils";
import type { AppInfo, AppSettings } from "../../../shared/ipc";

export function SettingsPage() {
  const { engineInfo, status, client } = useStation();
  const { profile, session, backendHeaders } = useAuth();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiBase, setApiBase] = useState("");
  const [stationName, setStationName] = useState("");
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.station.settings.get().then((s) => {
      setSettings(s);
      setApiBase(s.apiBaseUrl);
      setStationName(s.stationName);
    });
    void window.station.app.info().then(setInfo);
  }, []);

  const save = async (patch: Partial<AppSettings>) => {
    try {
      const next = await window.station.settings.set(patch);
      setSettings(next);
      setApiBase(next.apiBaseUrl);
      // Re-point the engine's uploads at the new backend.
      if (client && profile && session && (patch.apiBaseUrl || patch.stationName || patch.uploadEnabled !== undefined)) {
        await client.setSession({
          apiBase: next.apiBaseUrl,
          headers: backendHeaders(),
          user: { id: profile.id, email: profile.email, role: profile.role, company: profile.company, companyId: profile.companyId },
          stationName: next.stationName,
          uploadEnabled: next.uploadEnabled,
        });
      }
      toast.success("Settings saved");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Station</CardTitle>
          <CardDescription>Connection to Vision-M Studio.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Backend API URL</Label>
            <div className="flex gap-2">
              <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.example.com/api" />
              <Button variant="outline" onClick={() => void save({ apiBaseUrl: apiBase })} disabled={!settings || apiBase === settings.apiBaseUrl}>
                <Save className="mr-2 h-4 w-4" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Station name</Label>
            <div className="flex gap-2">
              <Input value={stationName} onChange={(e) => setStationName(e.target.value)} />
              <Button variant="outline" onClick={() => void save({ stationName })} disabled={!settings || stationName === settings.stationName}>
                <Save className="mr-2 h-4 w-4" /> Save
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Upload runs to Vision-M Studio</p>
              <p className="text-xs text-muted-foreground">
                Off: runs are saved on this PC only and shown in Reports. Turning it on uploads saved runs too.
              </p>
            </div>
            <Switch checked={settings?.uploadEnabled ?? false} onCheckedChange={(v) => void save({ uploadEnabled: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Start in fullscreen</p>
              <p className="text-xs text-muted-foreground">For dedicated operator screens. F11 toggles fullscreen anytime.</p>
            </div>
            <Switch checked={settings?.startFullscreen ?? false} onCheckedChange={(v) => void save({ startFullscreen: v })} />
          </div>
        </CardContent>
      </Card>

      <GpuCard />

      <StorageCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inference engine</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <InfoRow label="State" value={engineInfo?.state ?? "–"} />
          <InfoRow label="Loaded model" value={status?.model?.name ?? "None"} />
          <InfoRow label="Restarts this session" value={String(engineInfo?.restarts ?? 0)} />
          <InfoRow label="Uploads" value={status ? (status.sync.enabled ? `On · ${status.sync.pendingRuns} run(s) queued` : "Off (saved on this PC)") : "–"} />
          <InfoRow label="Last upload" value={formatDateTime(status?.sync.lastSuccessAt)} />
          {status?.sync.lastError && <InfoRow label="Last upload error" value={status.sync.lastError} />}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={() => void window.station.engine.restart()} disabled={status?.state === "running"}>
              <RotateCw className="mr-2 h-4 w-4" /> Restart engine
            </Button>
            <Button variant="outline" onClick={() => void window.station.app.openLogs()}>
              <FolderOpen className="mr-2 h-4 w-4" /> Open logs
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <InfoRow label="Version" value={info?.version ?? "–"} />
          <InfoRow label="Data folder" value={info?.dataDir ?? "–"} />
          <InfoRow label="Signed in as" value={`${profile?.email} (${profile?.role})`} />
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right" title={value}>
        {value}
      </span>
    </div>
  );
}
