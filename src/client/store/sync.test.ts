import { describe, it, expect } from "vitest";
import { planPull, resolveConflict, type LocalSnapshot } from "./sync";
import type { StateEnvelope } from "../../shared/api-types";
import { parseState, type AppState } from "../../shared/state";

const state = (text: string): AppState => parseState({ settings: { metric: text } });
const env = (rev: number, updatedAt: string, data = state("remote")): StateEnvelope<AppState> => ({ appId: "at-validator", schemaVersion: 1, rev, updatedAt, data });
const local = (over: Partial<LocalSnapshot> = {}): LocalSnapshot => ({ data: state("local"), localRev: 1, dirty: false, updatedAt: "2026-01-01T00:00:00Z", ...over });

describe("planPull", () => {
  it("pushes local data on first login when the server is empty", () => {
    expect(planPull(local({ localRev: 0 }), null, true)).toEqual({ action: "push" });
    expect(planPull(local({ localRev: 0 }), null, false)).toEqual({ action: "noop" });
    expect(planPull(local({ localRev: 0, dirty: true }), null, false)).toEqual({ action: "push" });
  });

  it("adopts a newer remote when local is clean", () => {
    expect(planPull(local({ localRev: 1 }), env(2, "x"), true)).toEqual({ action: "adopt-remote" });
  });

  it("flags a conflict when local is dirty and remote moved", () => {
    expect(planPull(local({ localRev: 1, dirty: true }), env(2, "x"), true)).toEqual({ action: "conflict" });
  });

  it("pushes dirty local when revs match, and no-ops when clean", () => {
    expect(planPull(local({ localRev: 2, dirty: true }), env(2, "x"), true)).toEqual({ action: "push" });
    expect(planPull(local({ localRev: 2 }), env(2, "x"), true)).toEqual({ action: "noop" });
  });

  it("rebases when the server rev went backwards (reset elsewhere)", () => {
    expect(planPull(local({ localRev: 5 }), env(1, "x"), true)).toEqual({ action: "rebase-and-push" });
  });
});

describe("resolveConflict", () => {
  it("last-writer-wins by updatedAt without a merge function", () => {
    const newerLocal = resolveConflict(local({ dirty: true, updatedAt: "2026-02-01T00:00:00Z" }), env(2, "2026-01-15T00:00:00Z"));
    expect(newerLocal.winner).toBe("local");
    expect(newerLocal.data.settings.metric).toBe("local");
    expect(newerLocal.backup?.side).toBe("remote");

    const newerRemote = resolveConflict(local({ dirty: true, updatedAt: "2026-01-01T00:00:00Z" }), env(2, "2026-01-15T00:00:00Z"));
    expect(newerRemote.winner).toBe("remote");
    expect(newerRemote.data.settings.metric).toBe("remote");
    expect(newerRemote.backup?.side).toBe("local");
  });

  it("uses the app merge function when provided", () => {
    const merge = (l: AppState, r: AppState): AppState => ({ ...l, settings: { ...l.settings, metric: l.settings.metric + "+" + r.settings.metric } });
    const r = resolveConflict(local({ dirty: true }), env(2, "x"), merge);
    expect(r.winner).toBe("merged");
    expect(r.data.settings.metric).toBe("local+remote");
  });
});
