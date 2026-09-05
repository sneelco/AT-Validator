import { describe, it, expect } from "vitest";
import { defaultState, mergeState, migrate, parseState, SCHEMA_VERSION, stateSchema } from "./state";

const act = (startTime: number, name = "Run") => ({
  name,
  sport: "Running",
  startTime,
  addedAt: 1,
  durationSec: 600,
  distanceM: 1500,
  source: "file",
  series: { dt: 5, n: 601, sp: Array.from({ length: 121 }, () => 250), hr: Array.from({ length: 121 }, () => 140), d: Array.from({ length: 121 }, (_, i) => i * 12.5) },
});

describe("at-validator state schema", () => {
  it("defaultState satisfies the schema", () => {
    const s = defaultState();
    expect(stateSchema.parse(s)).toEqual(s);
    expect(s.settings.units).toBe("imperial");
  });

  it("sanitizes activities, assigns ids and drops junk", () => {
    const s = parseState({ activities: [act(1_700_000_000), { nope: true }, null] });
    expect(s.activities).toHaveLength(1);
    expect(s.activities[0]?.id).toMatch(/^act-/);
  });

  it("sorts by start time", () => {
    const s = parseState({ activities: [act(2_000), act(1_000)] });
    expect(s.activities.map((a) => a.startTime)).toEqual([1_000, 2_000]);
  });

  it("fills settings defaults and rejects bad units", () => {
    expect(parseState({ settings: { minSegmentSec: 30 } }).settings).toMatchObject({ minSegmentSec: 30, trimLeadingWalk: true });
    expect(() => parseState({ settings: { units: "furlongs" } })).toThrow();
  });

  it("merges activities by identity and keeps local settings", () => {
    const local = parseState({ activities: [act(1_000), act(3_000)], settings: { units: "metric" } });
    const remote = parseState({ activities: [act(1_000, "Renamed"), act(2_000)] });
    const merged = mergeState(local, remote);
    expect(merged.activities.map((a) => a.startTime)).toEqual([1_000, 2_000, 3_000]);
    expect(merged.settings.units).toBe("metric");
  });

  it("migrate is identity for the current version and rejects newer", () => {
    const s = defaultState();
    expect(migrate(s, SCHEMA_VERSION)).toBe(s);
    expect(() => migrate({}, SCHEMA_VERSION + 1)).toThrow(/newer version/);
  });
});
