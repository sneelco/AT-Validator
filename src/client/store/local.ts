import { APP_ID } from "../../shared/app";
import { bootstrapState, parseState, SCHEMA_VERSION, type AppState } from "../../shared/state";

/**
 * localStorage persistence. localStorage is the source of truth for
 * rendering; the server is a replica (§8). Everything here is defensive:
 * storage may be missing, full, or hold data from an older schema version.
 */

export const LOCAL_KEY = `${APP_ID}:state`;
export const BACKUP_KEY = `${APP_ID}:conflict-backup`;

export interface LocalRecord {
  schemaVersion: number;
  data: AppState;
  /** Last server rev this device synced to (0 = never). */
  localRev: number;
  /** True when local edits have not been pushed. */
  dirty: boolean;
  /** When local data last changed (ISO). Used for last-writer-wins. */
  updatedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadLocal(): LocalRecord | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(LOCAL_KEY);
    if (!raw) return bootstrapLegacy();
    const rec = JSON.parse(raw) as Partial<LocalRecord>;
    const fromVersion = typeof rec.schemaVersion === "number" ? rec.schemaVersion : SCHEMA_VERSION;
    return {
      schemaVersion: SCHEMA_VERSION,
      data: parseState(rec.data, fromVersion),
      localRev: typeof rec.localRev === "number" ? rec.localRev : 0,
      dirty: rec.dirty === true,
      updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/** First run on this browser: let the app adopt pre-Outpost data (see shared/state.ts). */
function bootstrapLegacy(): LocalRecord | null {
  let data: AppState | null;
  try {
    data = bootstrapState();
  } catch {
    return null;
  }
  if (!data) return null;
  const rec: LocalRecord = { schemaVersion: SCHEMA_VERSION, data: parseState(data), localRev: 0, dirty: true, updatedAt: new Date().toISOString() };
  saveLocal(rec);
  return rec;
}

/** Returns false when the browser blocks storage (private mode, quota). */
export function saveLocal(rec: LocalRecord): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(LOCAL_KEY, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

export function clearLocal(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(LOCAL_KEY);
    s.removeItem(BACKUP_KEY);
  } catch {
    /* ignore */
  }
}

export interface ConflictBackup {
  savedAt: string;
  side: "local" | "remote";
  data: AppState;
}

export function saveConflictBackup(backup: ConflictBackup): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch {
    /* ignore */
  }
}

export function loadConflictBackup(): ConflictBackup | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(BACKUP_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as ConflictBackup;
    return { ...b, data: parseState(b.data) };
  } catch {
    return null;
  }
}
