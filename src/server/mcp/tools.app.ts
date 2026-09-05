/**
 * ★ APP BOUNDARY ★ — Aerobic Threshold Toolkit MCP tools.
 *
 * The stored state is the Zone 2 tracker history (compact per-activity
 * series) plus settings. These tools run the same walk/run analysis the
 * Tracker tab runs, so an assistant can discuss trends without the raw series.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getState } from "../state-store";
import { jsonResult, errorResult, type ToolContext } from "./tools.core";
import { defaultState, type Activity, type TrackerSettings } from "../../shared/state";
import "../../shared/atv/tracker-analysis.js";
import "../../shared/atv/tracker-store.js";
import type { AtvWindowMetrics } from "../../shared/atv/globals";

export type AppToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

const A = () => globalThis.ATV.trackerAnalysis;
const S = () => globalThis.ATV.trackerStore;

function unitFactors(settings: TrackerSettings) {
  const imperial = settings.units === "imperial";
  return { imperial, dist: imperial ? A().MI_M : A().KM_M, distLabel: imperial ? "mi" : "km" };
}

function paceMinPer(distanceUnit: number, speedMs: number | null) {
  if (!speedMs || speedMs <= 0.05) return null;
  const sec = distanceUnit / speedMs;
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

function metrics(m: AtvWindowMetrics, settings: TrackerSettings) {
  const u = unitFactors(settings);
  const units = m.distance / u.dist;
  return {
    seconds: m.seconds,
    movingSeconds: m.movingSeconds,
    distance: Number(units.toFixed(2)),
    distanceUnit: u.distLabel,
    avgPace: paceMinPer(u.dist, m.avgSpeed),
    walks: m.walks,
    walksPerUnit: units > 0.15 ? Number((m.walks / units).toFixed(2)) : null,
    runs: m.runs,
    runSeconds: m.runSeconds,
    walkSeconds: m.walkSeconds,
    avgRunSec: m.avgRunSec === null ? null : Math.round(m.avgRunSec),
    avgWalkSec: m.avgWalkSec === null ? null : Math.round(m.avgWalkSec),
    longestRunSec: m.longestRunSec,
    runPct: m.seconds ? Number(((100 * m.runSeconds) / m.seconds).toFixed(1)) : null,
    avgHr: m.avgHr === null ? null : Math.round(m.avgHr),
  };
}

function analyzeActivity(act: Activity, settings: TrackerSettings) {
  const samples = S().expandSeries(act.series);
  if (!samples) return null;
  return A().analyze(samples, {
    thresholdMs: settings.thresholdMs,
    minSegmentSec: settings.minSegmentSec,
    trimLeadingWalk: settings.trimLeadingWalk,
    trimTrailingWalk: settings.trimTrailingWalk,
    segmentDistance: unitFactors(settings).dist,
  });
}

function describe(act: Activity) {
  return {
    id: act.id,
    name: act.name,
    sport: act.sport,
    date: act.startTime ? new Date(act.startTime * 1000).toISOString() : null,
    durationSec: act.durationSec,
    distanceM: Math.round(act.distanceM),
    source: act.source,
  };
}

const listActivities: AppToolRegistrar = (server, ctx) => {
  server.registerTool(
    "list_activities",
    {
      title: "List tracker activities",
      description: "List the activities in the Zone 2 tracker history (id, name, sport, date, duration, distance), oldest first, plus the current tracker settings. Cheap; does not run the analysis.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const env = await getState(ctx.kv, ctx.userId);
      const state = env?.data ?? defaultState();
      return jsonResult({ count: state.activities.length, settings: state.settings, activities: state.activities.map(describe) });
    },
  );
};

const trackerMetrics: AppToolRegistrar = (server, ctx) => {
  server.registerTool(
    "tracker_metrics",
    {
      title: "Zone 2 tracker metrics",
      description: "Run the walk/run analysis over the stored activities under the saved settings and return, per activity, the measured window's metrics (walk breaks, walks per mile/km, pace, run/walk period lengths, time running, average HR) and the same for each fixed window (30, 45, 60… minutes). Use `ids` to limit to specific activities, `last` for the most recent N, and `bucketMinutes` to return just one fixed window.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Activity ids to include"),
        last: z.number().int().positive().max(200).optional().describe("Only the most recent N activities"),
        bucketMinutes: z.number().int().positive().optional().describe("Only this fixed window (e.g. 60); omit for all"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, last, bucketMinutes }) => {
      const env = await getState(ctx.kv, ctx.userId);
      const state = env?.data ?? defaultState();
      let acts = state.activities;
      if (ids?.length) acts = acts.filter((a) => ids.includes(a.id));
      if (last) acts = acts.slice(-last);
      if (acts.length === 0) return errorResult("No matching activities in the tracker history.");
      const rows = acts.map((a) => {
        const res = analyzeActivity(a, state.settings);
        if (!res) return { ...describe(a), error: "could not measure walk/run periods" };
        const buckets = res.buckets.filter((b) => !bucketMinutes || b.minutes === bucketMinutes).map((b) => ({ minutes: b.minutes, ...metrics(b.metrics, state.settings) }));
        return {
          ...describe(a),
          window: { startSec: res.window.start, endSec: res.window.end, trimmedLeadSec: res.window.trimmedLead, trimmedTailSec: res.window.trimmedTail, noRun: Boolean(res.window.noRun) },
          overall: metrics(res.overall, state.settings),
          buckets,
        };
      });
      return jsonResult({ settings: state.settings, activities: rows });
    },
  );
};

export const appTools: AppToolRegistrar[] = [listActivities, trackerMetrics];
