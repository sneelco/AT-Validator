import { create } from "zustand";
import { defaultState, SCHEMA_VERSION, type AppState } from "../../shared/state";
import { loadLocal, saveLocal, type LocalRecord } from "./local";

export type SyncStatus = "local-only" | "synced" | "pending" | "syncing" | "offline" | "conflict" | "error";

export interface AppStore {
  /** The app's state. Always render from here. */
  data: AppState;
  localRev: number;
  dirty: boolean;
  updatedAt: string;
  /** False when localStorage is unavailable; changes will not survive reload. */
  persisted: boolean;

  syncStatus: SyncStatus;
  syncError: string | null;
  lastSyncedAt: string | null;
  /** Human-readable note when a conflict was auto-resolved; cleared by the UI. */
  conflictNotice: string | null;

  /** Edit the state. The updater receives the current state and returns the next one. Marks the store dirty. */
  setData: (updater: AppState | ((prev: AppState) => AppState)) => void;
  /** Replace state from the server / an import without going through the dirty path. */
  replaceLocal: (data: AppState, meta: { localRev: number; dirty: boolean; updatedAt?: string }) => void;
  /** Adjust sync bookkeeping without touching data. */
  setSyncMeta: (meta: Partial<Pick<AppStore, "localRev" | "dirty" | "syncStatus" | "syncError" | "lastSyncedAt" | "conflictNotice">>) => void;
  /** Back to defaultState(), marked dirty so it syncs. */
  reset: () => void;
}

function initial(): Pick<AppStore, "data" | "localRev" | "dirty" | "updatedAt" | "persisted"> {
  const rec = loadLocal();
  if (rec) return { data: rec.data, localRev: rec.localRev, dirty: rec.dirty, updatedAt: rec.updatedAt, persisted: true };
  return { data: defaultState(), localRev: 0, dirty: false, updatedAt: new Date(0).toISOString(), persisted: true };
}

export const useAppState = create<AppStore>((set, get) => {
  const persist = (rec: LocalRecord) => set({ persisted: saveLocal(rec) });

  return {
    ...initial(),
    syncStatus: "local-only",
    syncError: null,
    lastSyncedAt: null,
    conflictNotice: null,

    setData: (updater) => {
      const prev = get();
      const data = typeof updater === "function" ? updater(prev.data) : updater;
      if (data === prev.data) return;
      const updatedAt = new Date().toISOString();
      set({ data, dirty: true, updatedAt });
      persist({ schemaVersion: SCHEMA_VERSION, data, localRev: prev.localRev, dirty: true, updatedAt });
    },

    replaceLocal: (data, meta) => {
      const updatedAt = meta.updatedAt ?? new Date().toISOString();
      set({ data, localRev: meta.localRev, dirty: meta.dirty, updatedAt });
      persist({ schemaVersion: SCHEMA_VERSION, data, localRev: meta.localRev, dirty: meta.dirty, updatedAt });
    },

    setSyncMeta: (meta) => {
      set(meta);
      if (meta.localRev !== undefined || meta.dirty !== undefined) {
        const s = get();
        persist({ schemaVersion: SCHEMA_VERSION, data: s.data, localRev: s.localRev, dirty: s.dirty, updatedAt: s.updatedAt });
      }
    },

    reset: () => get().setData(defaultState()),
  };
});

/** Convenience selector for app code: `const notes = useAppData((d) => d.notes)`. */
export function useAppData<T>(selector: (data: AppState) => T): T {
  return useAppState((s) => selector(s.data));
}

/** Non-hook access for event handlers: `setAppData((d) => ({ ...d, x }))`. */
export const setAppData = (updater: AppState | ((prev: AppState) => AppState)) => useAppState.getState().setData(updater);
