import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackendError, backendCall } from "./backend";
import { rememberAccount } from "./rememberedAccounts";

export type Role = "platform_admin" | "workspace_admin" | "ml_engineer" | "operator" | "viewer";

/** Mirrors VisionBackend utils/permissions.js: who may run inference. */
const RUN_ROLES: Role[] = ["platform_admin", "workspace_admin", "operator"];

export interface Profile {
  id: string;
  email: string;
  role: Role;
  companyId: string | null;
  company: string | null; // company name = backend "company" string
  fullName: string | null;
}

/** Signed-in session from VisionBackend (/api/auth). Same field names the Supabase session had. */
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // seconds since epoch
  user: { id: string; email: string };
}

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  profileError: string | null;
  canRun: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Headers VisionBackend expects (same as Vision-M Studio's getAuthHeaders). */
  backendHeaders(): Record<string, string>;
}

const AuthContext = createContext<AuthState | null>(null);

// The station stays signed in between restarts: the refresh token is kept on this computer
// (as the Supabase session was before). The access token lives 15 minutes and is renewed early.
const STORAGE_KEY = "station.auth.refreshToken";
const REFRESH_EARLY_MS = 60_000;

/** Turn sign-in errors into messages an operator can act on. */
function friendlyAuthError(error: { message: string; status?: number }): string {
  const msg = error.message || "";
  if (error.status === 429 || /rate limit|too many/i.test(msg)) return "Too many sign-in attempts. Wait a minute and try again.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(msg)) return "This email is not verified yet. Open the invitation email to verify it first.";
  if (/banned|disabled|deactivated/i.test(msg)) return "This account has been deactivated. Contact your workspace admin.";
  if (error.status === 0 || /fetch|network|reach/i.test(msg)) {
    return "Cannot reach the sign-in server. Check the internet connection and the API address in Settings, then try again.";
  }
  return msg || "Sign-in failed. Please try again.";
}

interface SessionReply {
  session: { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email: string } };
}

const toSession = (r: SessionReply): Session => ({
  access_token: r.session.access_token,
  refresh_token: r.session.refresh_token,
  expires_at: r.session.expires_at,
  user: { id: r.session.user.id, email: r.session.user.email },
});

async function loadProfile(session: Session): Promise<Profile> {
  let me: { profile: Record<string, any> | null; company: { name: string } | null };
  try {
    me = await backendCall({ method: "GET", path: "/auth/me", headers: { Authorization: `Bearer ${session.access_token}` } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/deactivated/i.test(msg)) throw new Error("This account has been deactivated. Contact your workspace admin.");
    if (/profile not found/i.test(msg)) throw new Error("No profile found for this account. Ask your workspace admin to invite you.");
    throw new Error(`Could not load your profile: ${msg}`);
  }
  const data = me.profile;
  if (!data) throw new Error("No profile found for this account. Ask your workspace admin to invite you.");
  if (data.is_active === false) throw new Error("This account has been deactivated. Contact your workspace admin.");
  return {
    id: data.id,
    email: data.email || session.user.email || "",
    role: (data.role || "viewer") as Role,
    companyId: data.company_id ?? null,
    company: me.company?.name ?? null,
    fullName: data.name ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // One renewal at a time (a refresh token works once)
  const renewing = useRef<Promise<Session | null> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Keep a session: save its refresh token and renew the access token shortly before it expires. */
  const keep = useCallback((s: Session | null) => {
    clearTimer();
    if (!alive.current) return;
    setSession(s);
    if (!s) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, s.refresh_token);
    const wait = Math.max(5_000, s.expires_at * 1000 - Date.now() - REFRESH_EARLY_MS);
    timer.current = setTimeout(() => void renewRef.current(), wait);
  }, []);

  /** Swap the saved refresh token for a new session. Network trouble keeps the current one and retries. */
  const renew = useCallback((): Promise<Session | null> => {
    if (renewing.current) return renewing.current;
    renewing.current = (async () => {
      const token = window.localStorage.getItem(STORAGE_KEY);
      if (!token) return null;
      try {
        const r = await backendCall<SessionReply>({ method: "POST", path: "/auth/refresh", body: { client: "native", refresh_token: token } });
        const s = toSession(r);
        keep(s);
        return s;
      } catch (err) {
        if (err instanceof BackendError && err.status === 0) {
          clearTimer();
          timer.current = setTimeout(() => void renewRef.current(), 15_000);
          return null;
        }
        // Signed out elsewhere, expired, or deactivated: back to the sign-in screen
        keep(null);
        setProfile(null);
        if (err instanceof BackendError && /deactivated/i.test(err.message)) {
          setProfileError("This account has been deactivated. Contact your workspace admin.");
        }
        return null;
      }
    })().finally(() => {
      renewing.current = null;
    });
    return renewing.current;
  }, [keep]);
  const renewRef = useRef(renew);
  renewRef.current = renew;

  const apply = useCallback(async (s: Session | null) => {
    if (!alive.current) return;
    if (!s) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const p = await loadProfile(s);
      if (alive.current) {
        setProfile(p);
        setProfileError(null);
        rememberAccount({ email: p.email, name: p.fullName, role: p.role, company: p.company });
      }
    } catch (err) {
      if (alive.current) setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // Start-up: continue the saved sign-in, if any
  useEffect(() => {
    alive.current = true;
    void renew().then((s) => apply(s));
    return () => {
      alive.current = false;
      clearTimer();
    };
  }, [renew, apply]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!navigator.onLine) throw new Error("No internet connection. Connect to the network and try again.");
    let r: SessionReply;
    try {
      r = await backendCall<SessionReply>({
        method: "POST",
        path: "/auth/login",
        body: { email: email.trim().toLowerCase(), password, client: "native" },
      });
    } catch (err) {
      const status = err instanceof BackendError ? err.status : 0;
      throw new Error(friendlyAuthError({ message: err instanceof Error ? err.message : String(err), status }));
    }
    const s = toSession(r);
    keep(s);
    setLoading(true);
    await apply(s);
  }, [keep, apply]);

  const signOut = useCallback(async () => {
    const token = window.localStorage.getItem(STORAGE_KEY);
    keep(null);
    setProfile(null);
    if (token) {
      await backendCall({ method: "POST", path: "/auth/logout", body: { client: "native", refresh_token: token } }).catch(() => undefined);
    }
  }, [keep]);

  const backendHeaders = useCallback((): Record<string, string> => {
    if (!session || !profile) return {};
    const h: Record<string, string> = {
      Authorization: `Bearer ${session.access_token}`,
      "X-User-Id": profile.id,
      "X-User-Role": profile.role,
      "X-User-Email": profile.email,
      "X-User-Company": profile.company || "",
    };
    if (profile.companyId) h["X-User-Company-Id"] = profile.companyId;
    return h;
  }, [session, profile]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      profileError,
      canRun: !!profile && RUN_ROLES.includes(profile.role),
      signIn,
      signOut,
      backendHeaders,
    }),
    [loading, session, profile, profileError, signIn, signOut, backendHeaders],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
