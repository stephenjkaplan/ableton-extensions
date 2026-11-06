import { describe, expect, it } from "vitest";
import { dbToRaw } from "../src/gain-map.js";
import { makePlan, type Plan } from "../src/plan.js";
import type { Role } from "../src/roles.js";
import type { Measure, SessionClip } from "../src/types.js";

interface Spec { key?: string; cur?: number | null; peak?: number; role?: Role; raw?: number }

function plan(specs: Spec[], target = -12): Plan {
  const clips: SessionClip[] = [];
  const roles = new Map<string, Role>();
  const measures = new Map<string, Measure>();
  specs.forEach((s, i) => {
    const key = s.key ?? `0:${i}`;
    clips.push({ key, trackIndex: 0, slotIndex: i, trackName: "A", name: `clip ${key}`, filePath: `${key}.wav`, rawGain: s.raw ?? 0.4,
                 warping: true, loopStart: 0, loopEnd: 8, warpMarkers: [] });
    roles.set(key, s.role ?? { kind: "track" });
    measures.set(key, { loudestLufs: s.cur === undefined ? -10 : s.cur, peakDb: s.cur === null ? null : s.peak ?? 0 });
  });
  return makePlan(clips, roles, measures, target);
}

describe("makePlan", () => {
  it("moves a track to the target", () => {
    const row = plan([{ cur: -10.2, peak: 4 }]).rows[0];
    expect(row.changeDb).toBeCloseTo(-1.8);
    expect(row.newRaw).toBeCloseTo(dbToRaw(-1.8).raw);
  });

  it("counts current gain in the loudness", () => {
    // 0.5 raw is +4 dB, so a -14 file already plays at -10.
    const row = plan([{ cur: -14, raw: 0.5 }]).rows[0];
    expect(row.changeDb).toBeCloseTo(-2);
    expect(row.newRaw).toBeCloseTo(dbToRaw(2).raw);
  });

  it("a layer takes its host's exact change", () => {
    const p = plan([{ key: "0:0", cur: -8.5 }, { key: "2:0", cur: -20, raw: 0.3, role: { kind: "layer", host: "0:0" } }]);
    expect(p.rows[1].changeDb).toBeCloseTo(-3.5);
    expect(p.rows[1].newRaw).toBeCloseTo(dbToRaw(-6.2 - 3.5).raw); // 0.3 raw is -6.2 dB
  });

  it("a layer's own loudness doesn't matter", () => {
    const p = plan([{ key: "0:0", cur: -8.5 }, { key: "2:0", cur: null, role: { kind: "layer", host: "0:0" } }]);
    expect(p.rows[1].changeDb).toBeCloseTo(-3.5);
    expect(p.rows[1].unread).toBe(false);
  });

  it("an unanswered layer doesn't change and is listed", () => {
    const p = plan([{ key: "2:0", role: { kind: "layer", host: null } }]);
    expect(p.rows[0].changeDb).toBeNull();
    expect(p.rows[0].newRaw).toBeNull();
    expect(p.needAnswer).toEqual(["2:0"]);
  });

  it("a leave-alone clip doesn't change", () => {
    const row = plan([{ role: { kind: "leave" } }]).rows[0];
    expect(row.changeDb).toBeNull();
    expect(row.newRaw).toBeNull();
  });

  it("an unread track doesn't change and is flagged", () => {
    const row = plan([{ cur: null }]).rows[0];
    expect(row.changeDb).toBeNull();
    expect(row.unread).toBe(true);
  });

  it("a layer on an unread host doesn't change", () => {
    const p = plan([{ key: "0:0", cur: null }, { key: "2:0", role: { kind: "layer", host: "0:0" } }]);
    expect(p.rows[1].changeDb).toBeNull();
  });

  it("a clip with its gain all the way down doesn't change", () => {
    const row = plan([{ cur: -10, raw: 0 }]).rows[0];
    expect(row.changeDb).toBeNull();
    expect(row.unread).toBe(true);
  });

  it("flags the weakest link and what matching it costs", () => {
    const p = plan([{ cur: -10.2, peak: 4 }, { cur: -9.3, peak: -2 }]);
    expect(p.weakest!.key).toBe("0:0");
    expect(p.weakest!.costDb).toBeCloseTo(0.2);
    expect(p.weakest!.matchTarget).toBeCloseTo(-12.2);
  });

  it("no weakest link once nothing is over the limit", () => {
    expect(plan([{ cur: -10.2, peak: 4 }], -12.2).weakest).toBeNull();
  });

  it("matching the weakest link leaves it exactly at the limit", () => {
    const first = plan([{ cur: -14, peak: 5 }]);
    expect(plan([{ cur: -14, peak: 5 }], first.weakest!.matchTarget).weakest).toBeNull();
  });

  it("layers can't be the weakest link", () => {
    const p = plan([{ key: "0:0", cur: -12, peak: -5 }, { key: "2:0", cur: -30, peak: 20, role: { kind: "layer", host: "0:0" } }]);
    expect(p.weakest).toBeNull();
  });

  it("summarises what's ready", () => {
    const p = plan([{ key: "0:0", cur: -8 }, { key: "0:1", cur: -16 }, { key: "2:0", role: { kind: "layer", host: "0:0" } },
                    { key: "2:1", role: { kind: "layer", host: null } }, { key: "2:2", role: { kind: "leave" } }, { key: "0:2", cur: null }]);
    expect(p.tracks).toBe(2);
    expect(p.layers).toBe(1);
    expect(p.biggestDown).toBeCloseTo(-4);
    expect(p.biggestUp).toBeCloseTo(4);
  });

  it("re-analyzing after Apply reads about 0 dB", () => {
    const first = plan([{ cur: -6.9, peak: 0 }]).rows[0];
    const again = plan([{ cur: -6.9, peak: 0, raw: first.newRaw! }]).rows[0];
    expect(Math.abs(again.changeDb!)).toBeLessThan(0.01);
  });

  it("flags a change the gain range can't reach", () => {
    expect(plan([{ cur: -60, peak: -40 }]).rows[0].clamped).toBe(true);
    expect(plan([{ cur: -10 }]).rows[0].clamped).toBe(false);
  });
});
