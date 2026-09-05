import { useAppState, type SyncStatus } from "../store/useAppState";
import { cn } from "../lib/utils";

const LABELS: Record<SyncStatus, { text: string; color: string; pulse?: boolean }> = {
  "local-only": { text: "Saved on this device only. Sign in to sync.", color: "bg-muted-foreground/50" },
  synced: { text: "Synced", color: "bg-emerald-500" },
  pending: { text: "Changes waiting to sync", color: "bg-amber-500" },
  syncing: { text: "Syncing…", color: "bg-amber-500", pulse: true },
  offline: { text: "Offline — changes are saved locally and will sync later", color: "bg-slate-400" },
  conflict: { text: "Resolved a conflict with another device", color: "bg-violet-500" },
  error: { text: "Sync error", color: "bg-red-500" },
};

/** The small status dot in the header (§8). */
export function SyncDot({ className }: { className?: string }) {
  const status = useAppState((s) => s.syncStatus);
  const error = useAppState((s) => s.syncError);
  const meta = LABELS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)} title={error ?? meta.text} aria-label={`Sync: ${meta.text}`}>
      <span className={cn("inline-block size-2 rounded-full", meta.color, meta.pulse && "animate-pulse")} />
      <span className="hidden sm:inline">{status === "local-only" ? "Local" : status === "synced" ? "Synced" : status === "pending" ? "Pending" : status === "syncing" ? "Syncing" : status === "offline" ? "Offline" : status === "conflict" ? "Merged" : "Error"}</span>
    </span>
  );
}
