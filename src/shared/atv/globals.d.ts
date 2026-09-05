/**
 * Loose typings for the vanilla toolkit modules in this directory and in
 * src/client/features/atv/js. They are ES5 IIFEs that attach an `ATV`
 * namespace to window/globalThis and also support CommonJS for the Node test
 * suite; they are imported for their side effects.
 */
export interface AtvSeries {
  dt: number;
  n: number;
  sp: number[];
  hr: number[];
  d: number[] | null;
}

export interface AtvActivity {
  id: string;
  name: string;
  sport: string | null;
  startTime: number | null;
  addedAt: number;
  durationSec: number;
  distanceM: number;
  source: string;
  series: AtvSeries;
}

export interface AtvSample {
  t: number;
  speed?: number;
  distance?: number;
  hr?: number;
}

export interface AtvStoreBackend {
  loadActivities(): unknown[];
  saveActivities(list: AtvActivity[]): void;
  loadSettings(): Record<string, unknown> | null;
  saveSettings(settings: Record<string, unknown>): void;
}

export interface AtvTrackerStore {
  KEY: string;
  SETTINGS_KEY: string;
  sanitize(raw: unknown): AtvActivity | null;
  sortActivities(list: AtvActivity[]): AtvActivity[];
  mergeActivities(existing: AtvActivity[], incoming: unknown[]): { list: AtvActivity[]; added: number; replaced: number };
  expandSeries(series: AtvSeries): AtvSample[] | null;
  toExport(list: AtvActivity[], nowSec: number): string;
  fromExport(text: string): { activities?: AtvActivity[]; skipped?: number; error?: string };
  load(): AtvActivity[];
  loadSettings(): Record<string, unknown> | null;
  setBackend(b: AtvStoreBackend | null): void;
  loadFromLocalStorage(): AtvActivity[];
  loadSettingsFromLocalStorage(): Record<string, unknown> | null;
}

export interface AtvWindowMetrics {
  seconds: number;
  movingSeconds: number;
  distance: number;
  avgSpeed: number | null;
  avgHr: number | null;
  walks: number;
  runs: number;
  walkSeconds: number;
  runSeconds: number;
  pausedSeconds: number;
  avgWalkSec: number | null;
  avgRunSec: number | null;
  longestRunSec: number | null;
  longestWalkSec: number | null;
  runDistance: number;
  [key: string]: unknown;
}

export interface AtvTrackerResult {
  window: { start: number; end: number; trimmedLead: number; trimmedTail: number; noRun?: boolean };
  total: { seconds: number; movingSeconds: number; distance: number; avgHr: number | null };
  overall: AtvWindowMetrics;
  buckets: { minutes: number; metrics: AtvWindowMetrics }[];
}

export interface AtvTrackerAnalysis {
  MPH_TO_MS: number;
  MI_M: number;
  KM_M: number;
  DEFAULTS: Record<string, number | boolean>;
  analyze(samples: AtvSample[], options?: Record<string, unknown>): AtvTrackerResult | null;
}

export interface AtvGlobal {
  trackerStore: AtvTrackerStore;
  trackerAnalysis: AtvTrackerAnalysis;
  tracker?: { reload(): void };
  [key: string]: unknown;
}

declare global {
  var ATV: AtvGlobal;
}
