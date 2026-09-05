import { useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router";
import { toast } from "sonner";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { APP } from "../../shared/app";
import { APP_VERSION } from "../../shared/version";
import { authClient, useSession } from "../auth/client";
import { clearLocal, loadConflictBackup } from "../store/local";
import { sync } from "../store/sync";
import { useAppState } from "../store/useAppState";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { downloadText, formatDateTime } from "../lib/utils";
import { buildExportEnvelope, parseImportFile } from "../lib/export";

/** /account — profile, API keys, sync, data export/import/reset (§11). */
export function AccountPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return null;
  if (!session) return <Navigate to="/sign-in" replace />;
  return (
    <div className="space-y-4 py-4">
      <ProfileCard email={session.user.email} name={session.user.name} />
      <SyncCard />
      <ApiKeysCard />
      <DataCard />
      <AboutCard />
    </div>
  );
}

function ProfileCard({ email, name }: { email: string; name: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>{name ? `${name} · ${email}` : email}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function SyncCard() {
  const status = useAppState((s) => s.syncStatus);
  const error = useAppState((s) => s.syncError);
  const lastSyncedAt = useAppState((s) => s.lastSyncedAt);
  const localRev = useAppState((s) => s.localRev);
  const [busy, setBusy] = useState(false);

  const syncNow = async () => {
    setBusy(true);
    await sync.flush().catch(() => undefined);
    await sync.pull().catch(() => undefined);
    setBusy(false);
  };

  const resetRemote = async () => {
    if (!window.confirm("Delete the copy of your data stored in your account? Local data on this device is kept and will be re-uploaded on the next change.")) return;
    setBusy(true);
    const res = await fetch("/api/state", { method: "DELETE" });
    if (res.ok || res.status === 204) {
      useAppState.getState().setSyncMeta({ localRev: 0, dirty: true });
      toast.success("Account data cleared. This device's data will sync up again.");
      await sync.flush().catch(() => undefined);
    } else {
      toast.error("Could not clear account data.");
    }
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>
          Status: <span className="font-medium text-foreground">{status}</span>
          {error ? ` — ${error}` : ""} · last synced {formatDateTime(lastSyncedAt)} · rev {localRev}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => void syncNow()} disabled={busy}>
          Sync now
        </Button>
        <Button variant="outline" size="sm" onClick={() => void resetRemote()} disabled={busy}>
          Reset account data
        </Button>
      </CardContent>
    </Card>
  );
}

interface ApiKeyRow {
  id: string;
  name?: string | null;
  start?: string | null;
  createdAt: string | Date;
  expiresAt?: string | Date | null;
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    authClient.apiKey.list().then((r) => {
      setKeys((r.data ?? []) as ApiKeyRow[]);
    });
  useEffect(() => {
    let alive = true;
    void authClient.apiKey.list().then((r) => {
      if (alive) setKeys((r.data ?? []) as ApiKeyRow[]);
    });
    return () => {
      alive = false;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    const r = await authClient.apiKey.create({ name: name.trim() || "MCP" });
    setBusy(false);
    if (r.error || !r.data) return toast.error(r.error?.message ?? "Could not create key.");
    setCreated(r.data.key);
    setName("");
    void refresh();
  };

  const remove = async (id: string) => {
    if (!window.confirm("Revoke this key? Any MCP client using it will stop working.")) return;
    const r = await authClient.apiKey.delete({ keyId: id });
    if (r.error) return toast.error(r.error.message ?? "Could not revoke key.");
    void refresh();
  };

  const mcpUrl = `${window.location.origin}/mcp`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys (MCP)</CardTitle>
        <CardDescription>
          Keys are the bearer token for the MCP endpoint at <code className="rounded bg-muted px-1">{mcpUrl}</code>. Each key is shown once. See{" "}
          <a className="underline underline-offset-4" href="https://github.com/sneelco/outpost/blob/main/docs/MCP.md" target="_blank" rel="noreferrer">
            docs/MCP.md
          </a>{" "}
          for Claude setup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {created && (
          <div className="rounded-md border border-primary/40 bg-accent p-3 text-sm">
            <p className="mb-2 font-medium">Copy this key now — it will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{created}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(created);
                  toast.success("Copied");
                }}
              >
                <Copy /> Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="key-name" className="sr-only">
              Key name
            </Label>
            <Input id="key-name" placeholder="Key name (e.g. Claude Desktop)" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button onClick={() => void create()} disabled={busy}>
            <KeyRound /> New key
          </Button>
        </div>
        {keys.length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 truncate">
                  <span className="font-medium">{k.name ?? "Unnamed"}</span>
                  {k.start && <span className="ml-2 text-muted-foreground">{k.start}…</span>}
                </span>
                <span className="text-xs text-muted-foreground">{formatDateTime(typeof k.createdAt === "string" ? k.createdAt : k.createdAt.toISOString())}</span>
                <Button size="icon" variant="ghost" aria-label="Revoke key" onClick={() => void remove(k.id)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DataCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const persisted = useAppState((s) => s.persisted);
  const backup = loadConflictBackup();

  const exportJson = () => {
    const s = useAppState.getState();
    downloadText(`${APP.id}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(buildExportEnvelope(s.data, s.localRev, s.updatedAt), null, 2));
  };

  const importJson = async (file: File) => {
    try {
      const data = parseImportFile(await file.text());
      useAppState.getState().setData(data);
      toast.success(`Imported ${file.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file.");
    }
  };

  const restoreBackup = () => {
    if (!backup) return;
    if (!window.confirm(`Replace current data with the ${backup.side} copy saved ${formatDateTime(backup.savedAt)}?`)) return;
    useAppState.getState().setData(backup.data);
    toast.success("Backup restored.");
  };

  const resetAll = () => {
    if (!window.confirm("Reset to a blank state? This also syncs the blank state to your account. Export first if you want a copy.")) return;
    useAppState.getState().reset();
  };

  const clearDevice = () => {
    if (!window.confirm("Remove this app's data from this browser only? Your account copy is untouched and will be pulled again on next sign-in.")) return;
    clearLocal();
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>
          {persisted ? "Saved in this browser on every change and synced to your account." : "This browser is blocking local storage; changes will be lost when you leave. Export to keep a copy."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={exportJson}>
          Export JSON
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          Import JSON
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importJson(f);
          }}
        />
        {backup && (
          <Button variant="outline" size="sm" onClick={restoreBackup} title={`${backup.side} copy from ${formatDateTime(backup.savedAt)}`}>
            Restore conflict backup
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={resetAll}>
          Reset data
        </Button>
        <Button variant="outline" size="sm" onClick={clearDevice}>
          Clear local data
        </Button>
      </CardContent>
    </Card>
  );
}

function AboutCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
        <CardDescription>
          {APP.name} · version <code className="rounded bg-muted px-1">{APP_VERSION.slice(0, 12)}</code> · built on{" "}
          <Link to="https://github.com/sneelco/outpost" className="underline underline-offset-4" target="_blank">
            Outpost
          </Link>
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
