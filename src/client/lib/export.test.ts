import { describe, it, expect } from "vitest";
import { buildExportEnvelope, parseImportFile } from "./export";
import { APP } from "../../shared/app";
import { defaultState } from "../../shared/state";

describe("export/import", () => {
  it("round-trips an envelope", () => {
    const s = defaultState();
    const env = buildExportEnvelope(s, 3, "2026-01-01T00:00:00.000Z");
    expect(env.appId).toBe(APP.id);
    expect(parseImportFile(JSON.stringify(env))).toEqual(s);
  });
  it("accepts a bare state object", () => {
    expect(parseImportFile(JSON.stringify(defaultState()))).toEqual(defaultState());
  });
  it("rejects other apps and junk", () => {
    expect(() => parseImportFile("{nope")).toThrow(/valid JSON/);
    expect(() => parseImportFile(JSON.stringify({ appId: "x", schemaVersion: 1, rev: 0, updatedAt: "", data: {} }))).toThrow(/from "x"/);
    expect(() => parseImportFile(JSON.stringify({ activities: 5 }))).toThrow();
  });
});
