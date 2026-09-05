import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { authClient, fetchPublicConfig, signIn, signUp, useSession, type PublicConfig } from "./client";
import { APP } from "../../shared/app";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

type Mode = "sign-in" | "sign-up" | "forgot";

export function SignIn() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void fetchPublicConfig().then(setConfig);
  }, []);
  useEffect(() => {
    if (session) navigate("/", { replace: true });
  }, [session, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "sign-in") {
        const r = await signIn.email({ email, password });
        if (r.error) throw new Error(r.error.message ?? "Sign-in failed.");
      } else if (mode === "sign-up") {
        const r = await signUp.email({ email, password, name: name || email.split("@")[0] || "User" });
        if (r.error) throw new Error(r.error.message ?? "Sign-up failed.");
      } else {
        const r = await authClient.requestPasswordReset({ email, redirectTo: "/sign-in" });
        if (r.error) throw new Error(r.error.message ?? "Request failed.");
        setInfo("If that address has an account, a reset link is on its way.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const github = async () => {
    setBusy(true);
    await signIn.social({ provider: "github", callbackURL: "/" });
  };

  return (
    <div className="mx-auto max-w-sm py-10">
      <Card>
        <CardHeader>
          <CardTitle>{mode === "sign-up" ? `Create your ${APP.name} account` : mode === "forgot" ? "Reset password" : `Sign in to ${APP.name}`}</CardTitle>
          <CardDescription>
            {mode === "sign-up"
              ? "Your data on this device will be synced to your account."
              : mode === "forgot"
                ? "We will email you a link to set a new password."
                : "Sync across devices and enable the MCP endpoint. Everything keeps working without an account."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config?.providers.github && mode !== "forgot" && (
            <>
              <Button variant="outline" className="w-full" onClick={() => void github()} disabled={busy}>
                <GitHubMark /> Continue with GitHub
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <form onSubmit={(e) => void submit(e)} className="space-y-3">
            {mode === "sign-up" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {mode !== "forgot" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" minLength={8} required autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {info && <p className="text-sm text-muted-foreground">{info}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {mode === "sign-in" ? "Sign in" : mode === "sign-up" ? "Create account" : "Send reset link"}
            </Button>
          </form>
          <div className="flex flex-col gap-1 text-center text-sm text-muted-foreground">
            {mode === "sign-in" ? (
              <>
                <button type="button" className="underline-offset-4 hover:underline" onClick={() => setMode("sign-up")}>
                  New here? Create an account
                </button>
                {config?.passwordReset ? (
                  <button type="button" className="underline-offset-4 hover:underline" onClick={() => setMode("forgot")}>
                    Forgot your password?
                  </button>
                ) : (
                  <span className="text-xs">Password reset is not available (no email transport configured).</span>
                )}
              </>
            ) : (
              <button type="button" className="underline-offset-4 hover:underline" onClick={() => setMode("sign-in")}>
                Back to sign in
              </button>
            )}
            <Link to="/" className="text-xs underline-offset-4 hover:underline">
              Continue without an account
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
