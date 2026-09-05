import { APP_ID } from "../../shared/app";
import type { ApiError, StateEnvelope } from "../../shared/api-types";
import * as stateModule from "../../shared/state";
import { parseState, type AppState } from "../../shared/state";
import { saveConflictBackup } from "./local";
import { useAppState, type SyncStatus } from "./useAppState";

/**
 * Remote sync engine (§8). Local-first: the store/localStorage is the source
 * of truth for rendering; this module keeps the server replica converged.
 *
 *  - Every local edit marks the store dirty → push() after a 3s debounce.
 *  - pull() on boot/sign-in, on `online`, on tab visibility, and every few
 *    minutes while visible. KV free tier allows ~1k writes/day, so pushes
 *    are debounced, coalesced, and skipped when nothing changed.
 *  - Conflicts (remote rev moved while we were dirty) resolve via the app's
 *    optional mergeState, else whole-blob last-writer-wins by updatedAt. The
 *    losing side is kept in localStorage under `:conflict-backup`.
 */

const PUSH_DEBOUNCE_MS = 3000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested in sync.test.ts)
// ---------------------------------------------------------------------------

export type MergeFn = (local: AppState, remote: AppState) => AppState;

export interface LocalSnapshot {
  data: AppState;
  localRev: number;
  dirty: boolean;
  updatedAt: string;
}

export type PullPlan =
  | { action: "noop" }
  | { action: "push" }
  | { action: "adopt-remote" }
  | { action: "conflict" }
  | { action: "rebase-and-push" };

/** Decide what to do with the server's answer to GET /api/state. */
export function planPull(local: LocalSnapshot, remote: StateEnvelope<AppState> | null, hasMeaningfulLocal: boolean): PullPlan {
  if (!remote) {
    // Nothing on the server yet. First login adopts local state.
    return hasMeaningfulLocal || local.dirty ? { action: "push" } : { action: "noop" };
  }
  if (remote.rev > local.localRev) return local.dirty ? { action: "conflict" } : { action: "adopt-remote" };
  if (remote.rev === local.localRev) return local.dirty ? { action: "push" } : { action: "noop" };
  // remote.rev < localRev: the server was reset/deleted from elsewhere. Our
  // data is the only copy; rebase our rev onto the server's and push.
  return { action: "rebase-and-push" };
}

export interface Resolution {
  data: AppState;
  winner: "local" | "remote" | "merged";
  /** The side that lost, for the conflict backup (null when merged). */
  backup: { side: "local" | "remote"; data: AppState } | null;
}

/** Resolve a dirty-local vs newer-remote conflict. */
export function resolveConflict(local: LocalSnapshot, remote: StateEnvelope<AppState>, merge?: MergeFn): Resolution {
  if (merge) {
    return { data: merge(local.data, remote.data), winner: "merged", backup: { side: "remote", data: remote.data } };
  }
  const localWins = local.updatedAt >= remote.updatedAt;
  return localWins
    ? { data: local.data, winner: "local", backup: { side: "remote", data: remote.data } }
    : { data: remote.data, winner: "remote", backup: { side: "local", data: local.data } };
}

/** Stable serialization used to skip no-op pushes. */
export function serialize(data: AppState): string {
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

// Apps opt into field-level merging by exporting `mergeState`; absent → last-writer-wins.
const appMerge: MergeFn | undefined = (stateModule as { mergeState?: MergeFn }).mergeState;

class SyncEngine {
  private signedIn = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastPushed: string | null = null;
  private writes = 0;
  private started = false;
  private unsubscribe: (() => void) | null = null;

  /** Attach listeners. Idempotent. */
  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.unsubscribe = useAppState.subscribe((s, prev) => {
      if (s.dirty && (s.data !== prev.data || !prev.dirty)) this.schedulePush();
    });
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.pullTimer = setInterval(() => {
      if (document.visibilityState === "visible") void this.pull();
    }, PULL_INTERVAL_MS);
    this.updateStatus();
  }

  stop() {
    this.unsubscribe?.();
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.started = false;
  }

  /** Called from the auth session hook whenever sign-in state changes. */
  setSignedIn(signedIn: boolean) {
    if (signedIn === this.signedIn) return;
    this.signedIn = signedIn;
    if (signedIn) void this.pull();
    else this.updateStatus();
  }

  isSignedIn() {
    return this.signedIn;
  }

  private onOnline = () => void this.pull();
  private onVisibility = () => {
    if (document.visibilityState === "visible") void this.pull();
  };

  private schedulePush() {
    if (!this.signedIn) return this.updateStatus();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.setStatus("pending");
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, PUSH_DEBOUNCE_MS);
  }

  /** Push immediately (e.g. before sign-out or a manual "sync now"). */
  flush() {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    return this.push();
  }

  /** Serialize pull/push so they never interleave. */
  private run(task: () => Promise<void>): Promise<void> {
    const next = (this.inFlight ?? Promise.resolve()).then(task, task);
    this.inFlight = next.finally(() => {
      if (this.inFlight === next) this.inFlight = null;
    });
    return this.inFlight;
  }

  pull(): Promise<void> {
    return this.run(() => this.doPull());
  }

  push(): Promise<void> {
    return this.run(() => this.doPush());
  }

  private async doPull() {
    if (!this.signedIn) return this.updateStatus();
    if (!navigator.onLine) return this.setStatus("offline");
    this.setStatus("syncing");
    let res: Response;
    try {
      res = await fetch("/api/state", { headers: { accept: "application/json" }, cache: "no-store" });
    } catch {
      return this.setStatus("offline");
    }
    if (res.status === 401) return this.signedOutByServer();
    if (res.status !== 200 && res.status !== 204) return this.fail(`Server returned ${res.status} on pull.`);

    const remote = res.status === 204 ? null : ((await res.json()) as StateEnvelope<AppState>);
    if (remote && remote.appId !== APP_ID) return this.fail("Server state belongs to a different app.");
    if (remote) remote.data = parseState(remote.data, remote.schemaVersion);

    const store = useAppState.getState();
    const local: LocalSnapshot = { data: store.data, localRev: store.localRev, dirty: store.dirty, updatedAt: store.updatedAt };
    const plan = planPull(local, remote, serialize(store.data) !== serialize(stateModule.defaultState()));

    switch (plan.action) {
      case "noop":
        if (!remote) store.setSyncMeta({ localRev: 0, dirty: false });
        return this.setStatus("synced", { lastSyncedAt: new Date().toISOString() });
      case "adopt-remote":
        store.replaceLocal(remote!.data, { localRev: remote!.rev, dirty: false, updatedAt: remote!.updatedAt });
        this.lastPushed = serialize(remote!.data);
        return this.setStatus("synced", { lastSyncedAt: new Date().toISOString() });
      case "push":
        if (!remote) store.setSyncMeta({ localRev: 0, dirty: true });
        return this.doPush();
      case "rebase-and-push":
        store.setSyncMeta({ localRev: remote!.rev, dirty: true });
        return this.doPush();
      case "conflict":
        this.applyConflict(local, remote!);
        return this.doPush();
    }
  }

  private applyConflict(local: LocalSnapshot, remote: StateEnvelope<AppState>) {
    const store = useAppState.getState();
    const r = resolveConflict(local, remote, appMerge);
    if (r.backup) saveConflictBackup({ savedAt: new Date().toISOString(), side: r.backup.side, data: r.backup.data });
    const dirty = r.winner !== "remote";
    store.replaceLocal(r.data, { localRev: remote.rev, dirty, updatedAt: dirty ? new Date().toISOString() : remote.updatedAt });
    const notice =
      r.winner === "merged"
        ? "Changes from another device were merged with yours."
        : r.winner === "local"
          ? "This device's newer changes replaced an older copy from another device."
          : "A newer copy from another device replaced this device's unsynced changes.";
    store.setSyncMeta({ conflictNotice: `${notice} The other version is kept as a backup on the account page.`, syncStatus: "conflict" });
  }

  private async doPush(retried = false): Promise<void> {
    if (!this.signedIn) return this.updateStatus();
    const store = useAppState.getState();
    if (!store.dirty) return this.setStatus("synced");
    const snapshot = serialize(store.data);
    if (snapshot === this.lastPushed) {
      store.setSyncMeta({ dirty: false });
      return this.setStatus("synced", { lastSyncedAt: new Date().toISOString() });
    }
    if (!navigator.onLine) return this.setStatus("offline");
    this.setStatus("syncing");

    let res: Response;
    try {
      res = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ baseRev: store.localRev, data: store.data }),
      });
    } catch {
      return this.setStatus("offline");
    }
    this.writes++;
    if (import.meta.env.DEV) console.debug(`[sync] KV writes this session: ${this.writes}`);

    if (res.status === 200) {
      const env = (await res.json()) as StateEnvelope<AppState>;
      this.lastPushed = snapshot;
      const now = useAppState.getState();
      // Data may have changed while the request was in flight; only clear
      // dirty if it did not.
      const stillSame = serialize(now.data) === snapshot;
      now.setSyncMeta({ localRev: env.rev, dirty: !stillSame, lastSyncedAt: new Date().toISOString() });
      if (stillSame) return this.setStatus("synced");
      return this.schedulePush();
    }
    if (res.status === 401) return this.signedOutByServer();
    if (res.status === 409) {
      const body = (await res.json()) as ApiError;
      const current = body.error.current as StateEnvelope<AppState> | undefined;
      if (!current || retried) return this.fail("Could not reconcile with the server copy.");
      current.data = parseState(current.data, current.schemaVersion);
      const local: LocalSnapshot = { data: store.data, localRev: store.localRev, dirty: true, updatedAt: store.updatedAt };
      if (current.rev === 0) {
        store.setSyncMeta({ localRev: 0 });
      } else {
        this.applyConflict(local, current);
      }
      return this.doPush(true);
    }
    let message = `Server returned ${res.status} on push.`;
    try {
      const body = (await res.json()) as ApiError;
      message = body.error.message ?? message;
    } catch {
      /* ignore */
    }
    return this.fail(message);
  }

  private signedOutByServer() {
    this.signedIn = false;
    this.updateStatus();
  }

  private fail(message: string) {
    this.setStatus("error", { syncError: message });
  }

  private setStatus(status: SyncStatus, extra: Partial<{ lastSyncedAt: string; syncError: string | null }> = {}) {
    const store = useAppState.getState();
    // Do not clobber a conflict notice's status until the UI dismisses it.
    if (store.syncStatus === "conflict" && store.conflictNotice && status === "synced") return;
    store.setSyncMeta({ syncStatus: status, syncError: status === "error" ? (extra.syncError ?? store.syncError) : null, ...(extra.lastSyncedAt ? { lastSyncedAt: extra.lastSyncedAt } : {}) });
  }

  private updateStatus() {
    const store = useAppState.getState();
    if (!this.signedIn) return this.setStatus("local-only");
    if (!navigator.onLine) return this.setStatus("offline");
    this.setStatus(store.dirty ? "pending" : "synced");
  }
}

export const sync = new SyncEngine();
