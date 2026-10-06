import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowLeft, Eye, EyeOff, Loader2, ScanLine, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { forgetAccount, listRememberedAccounts, type RememberedAccount } from "@/lib/rememberedAccounts";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateEmail(v: string): string | null {
  const t = v.trim();
  if (!t) return "Enter your email.";
  if (t.length > 254 || !EMAIL_RE.test(t)) return "Enter a valid email address.";
  return null;
}

function validatePassword(v: string): string | null {
  if (!v) return "Enter your password.";
  return null;
}

/** Same accounts as Vision-M Studio. No sign-up on stations: users are invited from the web app. */
export function LoginPage() {
  const { signIn } = useAuth();
  const [accounts, setAccounts] = useState<RememberedAccount[]>(() => listRememberedAccounts());
  // "pick" = choose a remembered account; "form" = email + password
  const [mode, setMode] = useState<"pick" | "form">(() => (listRememberedAccounts().length ? "pick" : "form"));
  const [selected, setSelected] = useState<RememberedAccount | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const emailError = selected ? null : validateEmail(email);
  const passwordError = validatePassword(password);

  const chooseAccount = (a: RememberedAccount) => {
    setSelected(a);
    setEmail(a.email);
    setPassword("");
    setTouched({ email: false, password: false });
    setError(null);
    setMode("form");
    setTimeout(() => passwordRef.current?.focus(), 0);
  };

  const useAnotherAccount = () => {
    setSelected(null);
    setEmail("");
    setPassword("");
    setTouched({ email: false, password: false });
    setError(null);
    setMode("form");
  };

  const backToAccounts = () => {
    setSelected(null);
    setPassword("");
    setError(null);
    setMode("pick");
  };

  const removeAccount = (a: RememberedAccount) => {
    forgetAccount(a.email);
    const next = listRememberedAccounts();
    setAccounts(next);
    if (next.length === 0) setMode("form");
  };

  const onPasswordKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.("CapsLock") ?? false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (emailError || passwordError || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword("");
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.15),transparent_60%)] p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ScanLine className="h-6 w-6" />
          </div>
          <CardTitle>Vision-M Station</CardTitle>
          <CardDescription>{mode === "pick" ? "Choose your account" : "Sign in with your Vision-M account"}</CardDescription>
        </CardHeader>
        <CardContent>
          {mode === "pick" ? (
            <div className="space-y-2">
              {accounts.map((a) => (
                <div key={a.email} className="group flex items-center gap-3 rounded-md border p-3 transition-colors hover:border-primary hover:bg-primary/5">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => chooseAccount(a)}>
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                      {(a.name || a.email).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.name || a.email}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.name ? a.email : ""}
                        {a.role ? `${a.name ? " · " : ""}${a.role.replace(/_/g, " ")}` : ""}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                    title="Remove from this station"
                    aria-label={`Remove ${a.email} from this station`}
                    onClick={() => removeAccount(a)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button variant="outline" className="w-full" onClick={useAnotherAccount}>
                <UserRound className="mr-2 h-4 w-4" /> Use another account
              </Button>
              <p className="pt-1 text-center text-xs text-muted-foreground">Only emails are remembered. Passwords are never saved.</p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="space-y-4">
              {selected ? (
                <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {(selected.name || selected.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{selected.name || selected.email}</p>
                    {selected.name && <p className="truncate text-xs text-muted-foreground">{selected.email}</p>}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    maxLength={254}
                    value={email}
                    aria-invalid={touched.email && !!emailError}
                    className={cn(touched.email && emailError && "border-destructive focus-visible:ring-destructive")}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                    onBlur={() => {
                      setEmail((v) => v.trim());
                      setTouched((t) => ({ ...t, email: true }));
                    }}
                  />
                  {touched.email && emailError && <p className="text-xs text-destructive">{emailError}</p>}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    ref={passwordRef}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus={!!selected}
                    maxLength={128}
                    value={password}
                    aria-invalid={touched.password && !!passwordError}
                    className={cn("pr-10", touched.password && passwordError && "border-destructive focus-visible:ring-destructive")}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={onPasswordKey}
                    onKeyUp={onPasswordKey}
                    onBlur={() => {
                      setCapsLock(false);
                      setTouched((t) => ({ ...t, password: true }));
                    }}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {touched.password && passwordError && <p className="text-xs text-destructive">{passwordError}</p>}
                {capsLock && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5" /> Caps Lock is on
                  </p>
                )}
              </div>

              {error && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {busy ? "Signing in…" : "Sign in"}
              </Button>

              {accounts.length > 0 ? (
                <Button type="button" variant="ghost" className="w-full" onClick={backToAccounts} disabled={busy}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Choose a different account
                </Button>
              ) : (
                <p className="text-center text-xs text-muted-foreground">Need an account? Ask your workspace admin to invite you from Vision-M Studio.</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
