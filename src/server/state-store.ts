import { APP_ID } from "../shared/app";
import { MAX_STATE_BYTES, envelopeSchema, type StateEnvelope } from "../shared/api-types";
import { parseState, SCHEMA_VERSION, type AppState } from "../shared/state";

/**
 * KV persistence for the per-user state envelope.
 *
 * KV is eventually consistent across edges (§15): a read may lag a write by
 * up to ~60s at another location. The rev check makes that safe — a stale
 * client gets a 409 and re-pulls — so nothing here assumes read-after-write.
 */

export const stateKey = (userId: string) => `state:${userId}`;

export type PutResult =
  | { ok: true; envelope: StateEnvelope<AppState> }
  | { ok: false; reason: "conflict"; current: StateEnvelope<AppState> }
  | { ok: false; reason: "too_large"; bytes: number };

export async function getState(kv: KVNamespace, userId: string): Promise<StateEnvelope<AppState> | null> {
  const raw = await kv.get(stateKey(userId), "text");
  if (raw === null) return null;
  return decodeEnvelope(raw);
}

/**
 * Optimistic write. `baseRev` must equal the stored rev (or 0 when nothing is
 * stored). On success the stored rev becomes baseRev + 1.
 */
export async function putState(
  kv: KVNamespace,
  userId: string,
  baseRev: number,
  data: AppState,
  now: Date = new Date(),
): Promise<PutResult> {
  const current = await getState(kv, userId);
  const currentRev = current?.rev ?? 0;
  if (baseRev !== currentRev) {
    return { ok: false, reason: "conflict", current: current ?? emptyEnvelope(now) };
  }
  return writeEnvelope(kv, userId, currentRev + 1, data, now);
}

/**
 * Unconditional write used by MCP tools: the caller is assumed to have just
 * read. Still bumps rev so browsers notice the change.
 */
export async function replaceState(
  kv: KVNamespace,
  userId: string,
  data: AppState,
  now: Date = new Date(),
): Promise<PutResult> {
  const current = await getState(kv, userId);
  return writeEnvelope(kv, userId, (current?.rev ?? 0) + 1, data, now);
}

export async function deleteState(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(stateKey(userId));
}

async function writeEnvelope(
  kv: KVNamespace,
  userId: string,
  rev: number,
  data: AppState,
  now: Date,
): Promise<PutResult> {
  const envelope: StateEnvelope<AppState> = {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    rev,
    updatedAt: now.toISOString(),
    data,
  };
  const serialized = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_STATE_BYTES) return { ok: false, reason: "too_large", bytes };
  await kv.put(stateKey(userId), serialized);
  return { ok: true, envelope };
}

/**
 * Decode a stored envelope, migrating the data forward if it was written by
 * an older schema version. A blob from a different app (should never happen,
 * each app has its own namespace) or an unreadable one is treated as absent
 * rather than crashing every request for that user.
 */
export function decodeEnvelope(raw: string): StateEnvelope<AppState> | null {
  try {
    const parsed = envelopeSchema.parse(JSON.parse(raw));
    if (parsed.appId !== APP_ID) return null;
    const data = parseState(parsed.data, parsed.schemaVersion);
    return { ...parsed, schemaVersion: SCHEMA_VERSION, data };
  } catch {
    return null;
  }
}

function emptyEnvelope(now: Date): StateEnvelope<AppState> {
  return { appId: APP_ID, schemaVersion: SCHEMA_VERSION, rev: 0, updatedAt: now.toISOString(), data: parseState({}) };
}
