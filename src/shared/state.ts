/**
 * ★ APP BOUNDARY ★ — Aerobic Threshold Toolkit state.
 *
 * Only the Zone 2 tracker keeps data: a list of activities (each a compact
 * 5-second series so history can be re-measured under new settings) and the
 * tracker settings. The validator tab works on a file you drop in and keeps
 * nothing but a couple of device preferences in localStorage.
 *
 * Validation reuses the toolkit's own `sanitize` (defensive against
 * hand-edited imports) and then checks the strict shape with Zod.
 */
import { z } from "zod";
import "./atv/tracker-analysis.js";
import "./atv/tracker-store.js";
import type { AtvActivity } from "./atv/globals";

export const SCHEMA_VERSION = 1;

const store = () => globalThis.ATV.trackerStore;

const seriesSchema = z.object({
  dt: z.number().int().positive(),
  n: z.number().int().positive(),
  sp: z.array(z.number()),
  hr: z.array(z.number()),
  d: z.array(z.number()).nullable(),
});

export const activitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  sport: z.string().nullable(),
  startTime: z.number().nullable(),
  addedAt: z.number(),
  durationSec: z.number(),
  distanceM: z.number(),
  source: z.string(),
  series: seriesSchema,
});

const MPH = 0.44704;

export const settingsSchema = z.object({
  /** Walk/run split, metres per second. */
  thresholdMs: z.number().positive().default(4 * MPH),
  minSegmentSec: z.number().min(5).max(300).default(20),
  trimLeadingWalk: z.boolean().default(true),
  trimTrailingWalk: z.boolean().default(true),
  units: z.enum(["imperial", "metric"]).default("imperial"),
  /** Trend chart metric id (see METRICS in tracker.js). */
  metric: z.string().default("walks"),
  /** Fixed windows (minutes) plotted on the trend chart; null = auto. */
  buckets: z.array(z.union([z.number(), z.literal("full")])).nullable().default(null),
});

/** Lenient list (anything sanitize accepts, junk dropped) → strict activities, sorted. */
const activitiesSchema = z
  .array(z.unknown())
  .transform((list) => store().sortActivities(list.map((a) => store().sanitize(a)).filter((a): a is AtvActivity => a !== null)))
  .pipe(z.array(activitySchema));

export const stateSchema = z.object({
  activities: activitiesSchema.default(() => []),
  settings: settingsSchema.default(() => settingsSchema.parse({})),
});

export type Activity = z.infer<typeof activitySchema>;
export type TrackerSettings = z.infer<typeof settingsSchema>;
export type AppState = z.infer<typeof stateSchema>;

export function defaultState(): AppState {
  return { activities: [], settings: settingsSchema.parse({}) };
}

export function migrate(data: unknown, fromVersion: number): unknown {
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`State was written by a newer version (v${fromVersion}, this build understands v${SCHEMA_VERSION}).`);
  }
  let current = data;
  if (fromVersion < 1) current = defaultState();
  return current;
}

export function parseState(data: unknown, fromVersion: number = SCHEMA_VERSION): AppState {
  return stateSchema.parse(migrate(data, fromVersion));
}

/**
 * First run on this browser: adopt the history and settings the standalone
 * toolkit kept under `atv-tracker-activities-v1` / `atv-tracker-settings-v1`.
 */
export function bootstrapState(): AppState | null {
  const activities = store().loadFromLocalStorage();
  const settings = store().loadSettingsFromLocalStorage();
  if (activities.length === 0 && !settings) return null;
  return parseState({ activities, settings: settings ?? undefined });
}

/**
 * Conflict merge: activities are keyed by id (same start time + duration), so
 * a union never duplicates a run and keeps runs added on either device.
 * Removal on one device while the other adds is resolved in favour of keeping
 * data. Settings follow whole-blob last-writer-wins.
 */
export function mergeState(local: AppState, remote: AppState): AppState {
  const merged = store().mergeActivities(remote.activities, local.activities).list;
  return { activities: merged, settings: local.settings };
}
