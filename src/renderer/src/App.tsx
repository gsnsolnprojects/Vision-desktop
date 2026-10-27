import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Boxes, Cpu, FileBarChart2, Loader2, LogOut, Radio, Settings, SlidersHorizontal } from "lucide-react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { StationProvider, useStation } from "@/lib/station";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LoginPage } from "@/pages/LoginPage";
import { ModelsPage } from "@/pages/ModelsPage";
import { RunSetupPage } from "@/pages/RunSetupPage";
import { LivePage } from "@/pages/LivePage";
import { ReportsPage } from "@/pages/ReportsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { EngineBanner } from "@/components/EngineBanner";
import { RuntimeSetupScreen } from "@/components/RuntimeSetupScreen";
import { useEngine } from "@/lib/engine";
import { GpuWarningBanner } from "@/components/GpuWarningBanner";
import { StorageWarningBanner } from "@/components/StorageWarningBanner";

export type Page = "live" | "setup" | "models" | "reports" | "settings";

export default function App() {
  const { info } = useEngine();
  // Installed app, first launch: the AI runtime must be downloaded before anything else can work.
  if (info && (info.state === "installing" || info.setup?.phase === "failed")) {
    return <RuntimeSetupScreen info={info} />;
  }
  return (
    <AuthProvider>
      <Gate />
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </AuthProvider>
  );
}

function Gate() {
  const { loading, session, profile, profileError, signOut } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!session) return <LoginPage />;
  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-md text-sm text-destructive">{profileError ?? "Could not load your account."}</p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }
  return (
    <StationProvider>
      <Shell />
    </StationProvider>
  );
}

const NAV: { id: Page; label: string; icon: typeof Radio }[] = [
  { id: "live", label: "Live Inspection", icon: Radio },
  { id: "setup", label: "Run Setup", icon: SlidersHorizontal },
  { id: "models", label: "Models", icon: Boxes },
  { id: "reports", label: "Reports", icon: FileBarChart2 },
  { id: "settings", label: "Settings", icon: Settings },
];

function Shell() {
  const { profile, signOut } = useAuth();
  const { status, engineInfo } = useStation();
  const running = status?.state === "running";
  const [page, setPage] = useState<Page>("setup");

  // Jump to the live view when a run starts (also after an app reload mid-run).
  useEffect(() => {
    if (running) setPage("live");
  }, [running]);

  // F11 toggles fullscreen for operator stations.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void window.station.app.toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card/40">
        <div className="px-4 py-5">
          <p className="text-lg font-semibold tracking-tight">Vision-M</p>
          <p className="text-xs text-muted-foreground">Station</p>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                page === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
              {id === "live" && running && <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />}
            </button>
          ))}
        </nav>
        <div className="space-y-2 border-t p-3 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" />
            <span className={cn("truncate", status && !status.gpu.cuda && "text-amber-500")} title={status?.gpu.name ?? undefined}>
              {status ? (status.gpu.cuda ? status.gpu.name : "CPU only (no CUDA GPU)") : engineInfo?.state === "ready" ? "…" : "Engine offline"}
            </span>
          </div>
          {status && status.sync.enabled && status.sync.pendingRuns > 0 && (
            <p className="text-amber-500">{status.sync.pendingRuns} run(s) waiting to upload</p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="min-w-0">
              <p className="truncate font-medium">{profile?.fullName || profile?.email}</p>
              <p className="truncate text-muted-foreground">{profile?.company ?? "No workspace"} · {profile?.role}</p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              title={running ? "Stop the run before signing out" : "Sign out"}
              disabled={running}
              onClick={() => void signOut()}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <EngineBanner />
        <GpuWarningBanner />
        <StorageWarningBanner />
        <div className="min-h-0 flex-1 overflow-auto">
          {page === "live" && <LivePage onNavigate={setPage} />}
          {page === "setup" && <RunSetupPage onNavigate={setPage} />}
          {page === "models" && <ModelsPage onNavigate={setPage} />}
          {page === "reports" && <ReportsPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
