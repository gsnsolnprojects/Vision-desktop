import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
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

/** Turn Supabase auth errors into messages an operator can act on. */
function friendlyAuthError(error: { message: string; status?: number; code?: string; name?: string }): string {
  const msg = error.message || "";
  if (error.status === 429 || /rate limit|too many/i.test(msg)) return "Too many sign-in attempts. Wait a minute and try again.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(msg)) return "This email is not verified yet. Open the invitation email to verify it first.";
  if (/banned|disabled/i.test(msg)) return "This account has been deactivated. Contact your workspace admin.";
  if (error.name === "AuthRetryableFetchError" || /fetch|network/i.test(msg) || error.status === 0) {
    return "Cannot reach the sign-in server. Check the internet connection and try again.";
  }
  return msg || "Sign-in failed. Please try again.";
}

async function loadProfile(session: Session): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role, company_id, name, is_active")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw new Error(`Could not load your profile: ${error.message}`);
  if (!data) throw new Error("No profile found for this account. Ask your workspace admin to invite you.");
  if (data.is_active === false) throw new Error("This account has been deactivated. Contact your workspace admin.");

  let company: string | null = null;
  if (data.company_id) {
    const { data: c } = await supabase.from("companies").select("name").eq("id", data.company_id).maybeSingle();
    company = c?.name ?? null;
  }
  return {
    id: data.id,
    email: data.email || session.user.email || "",
    role: (data.role || "viewer") as Role,
    companyId: data.company_id ?? null,
    company,
    fullName: data.name ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = async (s: Session | null) => {
      if (!alive) return;
      setSession(s);
      if (!s) {
        setProfile(null);
        setLoading(false);
        return;
      }
      try {
        const p = await loadProfile(s);
        if (alive) {
          setProfile(p);
          setProfileError(null);
          rememberAccount({ email: p.email, name: p.fullName, role: p.role, company: p.company });
        }
      } catch (err) {
        if (alive) setProfileError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "TOKEN_REFRESHED") {
        setSession(s); // profile unchanged; only the bearer token rotated
      } else if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        // Defer: supabase-js warns against awaiting other supabase calls inside this callback.
        setTimeout(() => void apply(s), 0);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!navigator.onLine) throw new Error("No internet connection. Connect to the network and try again.");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new Error(friendlyAuthError(error));
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

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
