import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Controller, type LiveBridge, type ViewState } from "../src/controller.js";
import { rawToDb } from "../src/gain-map.js";
import { Store } from "../src/store.js";
import type { ArrangementClip, LiveScan, Measure, SessionClip } from "../src/types.js";

const SET = "/sets/Halloween.als";

function clip(trackIndex: number, slotIndex: number, filePath: string, rawGain = 0.4): SessionClip {
  return { key: `${trackIndex}:${slotIndex}`, trackIndex, slotIndex, trackName: `T${trackIndex}`, name: filePath, filePath, rawGain,
           warping: true, loopStart: 0, loopEnd: 8, warpMarkers: [] };
}

class FakeLive implements LiveBridge {
  session: SessionClip[] = [];
  arrangement: ArrangementClip[] = [];
  setPath = SET;
  writes: [string, number][] = [];
  beforeWrite: (key: string, n: number) => void = () => {};
  readBack: (raw: number) => number = (raw) => raw;
  scans = 0;

  async scan(): Promise<LiveScan> {
    this.scans++;
    const tracks = [...new Set(this.session.map((c) => c.trackIndex))];
    return {
      setPath: this.setPath,
      session: this.session.map((c) => ({ ...c })),
      arrangement: this.arrangement,
      layerCandidates: tracks.map((trackIndex) => ({ trackIndex, trackName: `T${trackIndex}` })),
    };
  }

  async setGain(trackIndex: number, slotIndex: number, raw: number): Promise<number> {
    const key = `${trackIndex}:${slotIndex}`;
    this.beforeWrite(key, this.writes.length);
    this.writes.push([key, raw]);
    const c = this.session.find((x) => x.key === key)!;
    c.rawGain = this.readBack(raw);
    return c.rawGain;
  }

  gain(key: string) { return this.session.find((c) => c.key === key)!.rawGain; }
}

let base: string;
let live: FakeLive;
let measures: Record<string, Measure>;
let measured: string[];
let state: ViewState;

const fresh = () => new Controller(live, base, async (c) => {
  measured.push(c.key);
  return measures[c.filePath] ?? { loudestLufs: null, peakDb: null };
}, (s) => { state = s; });

async function ready(): Promise<Controller> {
  const ctl = fresh();
  await ctl.analyze();
  if (state.needsLanes) await ctl.setLayerTracks([2]);
  return ctl;
}

const row = (key: string) => state.rows.find((r) => r.key === key)!;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sl-ctl-"));
  live = new FakeLive();
  live.session = [clip(0, 0, "a.wav"), clip(1, 0, "b.wav", 0.5), clip(2, 0, "vox.wav", 0.3), clip(2, 1, "lost.wav")];
  live.arrangement = [{ filePath: "vox.wav", start: 0, end: 8 }, { filePath: "a.wav", start: 0, end: 8 }];
  measures = {
    "a.wav": { loudestLufs: -10, peakDb: 0 },
    "b.wav": { loudestLufs: -20, peakDb: -2 },
    "vox.wav": { loudestLufs: -18, peakDb: -3 },
    "lost.wav": { loudestLufs: -18, peakDb: -3 },
  };
  measured = [];
});

describe("first run", () => {
  it("asks which lanes hold layers, without measuring yet", async () => {
    const ctl = fresh();
    await ctl.analyze();
    expect(state.needsLanes).toBe(true);
    expect(state.candidates.map((c) => c.trackIndex)).toEqual([0, 1, 2]);
    expect(measured).toEqual([]);
    await ctl.setLayerTracks([2]);
    expect(state.needsLanes).toBe(false);
    expect(state.phase).toBe("ready");
  });

  it("doesn't ask again for the same Set", async () => {
    await ready();
    await fresh().analyze();
    expect(state.needsLanes).toBe(false);
    expect(state.phase).toBe("ready");
  });

  it("nothing is written by analyzing", async () => {
    await ready();
    expect(live.writes).toEqual([]);
  });

  it("an unreadable clip doesn't stop the run", async () => {
    delete measures["b.wav"];
    await ready();
    expect(row("1:0").unread).toBe(true);
    expect(row("0:0").changeDb).toBeCloseTo(-2);
  });

  it("reports progress while measuring", async () => {
    const seen: number[] = [];
    const ctl = new Controller(live, base, async () => ({ loudestLufs: -10, peakDb: 0 }), (s) => { state = s; if (s.progress) seen.push(s.progress.done); });
    await ctl.analyze();
    await ctl.setLayerTracks([2]);
    expect(seen).toContain(4);
  });
});

describe("roles and target", () => {
  it("suggests hosts and asks about the rest", async () => {
    await ready();
    expect(row("2:0").role).toEqual({ kind: "layer", host: "0:0" });
    expect(state.needAnswer).toEqual(["2:1"]);
  });

  it("changing the target doesn't re-measure", async () => {
    const ctl = await ready();
    const n = measured.length;
    ctl.setTarget(-14);
    expect(row("0:0").changeDb).toBeCloseTo(-4);
    expect(measured.length).toBe(n);
  });

  it("ignores a target that isn't a number", async () => {
    const ctl = await ready();
    ctl.setTarget(Number.NaN);
    expect(state.target).toBe(-12);
  });

  it("match weakest sets the target to matchTarget", async () => {
    measures["a.wav"] = { loudestLufs: -14, peakDb: 5 };
    const ctl = await ready();
    expect(state.weakest!.key).toBe("0:0");
    ctl.matchWeakest();
    expect(state.target).toBeCloseTo(-17); // a peak 19 dB over its loudness fits a +2 limit at -17
    expect(state.weakest).toBeNull();
  });

  it("answers and target survive a new Controller for the same Set", async () => {
    const ctl = await ready();
    ctl.setRole("2:1", { kind: "layer", host: "1:0" });
    ctl.setTarget(-13);
    await fresh().analyze();
    expect(row("2:1").role).toEqual({ kind: "layer", host: "1:0" });
    expect(state.target).toBe(-13);
  });

  it("another Set gets its own answers", async () => {
    const ctl = await ready();
    ctl.setRole("2:1", { kind: "leave" });
    live.setPath = "/sets/Other.als";
    await fresh().analyze();
    expect(state.needsLanes).toBe(true);
  });

  it("an answer for a slot now holding a different file is dropped", async () => {
    const ctl = await ready();
    ctl.setRole("2:1", { kind: "leave" });
    live.session[3].filePath = "swapped.wav";
    await fresh().analyze();
    expect(row("2:1").role).toEqual({ kind: "layer", host: null });
  });

  it("an answer whose host slot now holds a different file is dropped", async () => {
    const ctl = await ready();
    ctl.setRole("2:1", { kind: "layer", host: "1:0" });
    live.session[1].filePath = "swapped.wav";
    await fresh().analyze();
    expect(row("2:1").role).toEqual({ kind: "layer", host: null });
  });
});

describe("apply", () => {
  it("saves the snapshot before the first write", async () => {
    const ctl = await ready();
    let snapshotAtFirstWrite: unknown = null;
    live.beforeWrite = (_, n) => { if (n === 0) snapshotAtFirstWrite = new Store(base, SET).latestSnapshot(); };
    await ctl.apply();
    expect(snapshotAtFirstWrite).not.toBeNull();
  });

  it("the snapshot holds the exact raw gains it'll change", async () => {
    live.session[0].rawGain = 0.4000000059604645;
    const ctl = await ready();
    await ctl.apply();
    const snap = new Store(base, SET).latestSnapshot()!;
    expect(snap.find((e) => e.key === "0:0")!.rawGain).toBe(0.4000000059604645);
    expect(snap.map((e) => e.key).sort()).toEqual(["0:0", "1:0", "2:0"]);
  });

  it("moves tracks to the target and layers with their host", async () => {
    const ctl = await ready();
    await ctl.apply();
    expect(rawToDb(live.gain("0:0"))).toBeCloseTo(-2);
    expect(rawToDb(live.gain("1:0"))).toBeCloseTo(8); // -20 file: +8 dB from 0 to reach -12, but it's already +4
    expect(rawToDb(live.gain("2:0"))).toBeCloseTo(rawToDb(0.3) - 2);
  });

  it("only writes rows with a change", async () => {
    const ctl = await ready();
    ctl.setRole("1:0", { kind: "leave" });
    delete measures["a.wav"];
    await ctl.apply();
    expect(live.writes.map((w) => w[0]).sort()).toEqual(["0:0", "2:0"]);
    expect(live.gain("2:1")).toBe(0.4); // unanswered
  });

  it("doesn't write or snapshot when nothing would change", async () => {
    const ctl = await ready();
    await ctl.apply();
    const writes = live.writes.length;
    await ctl.apply();
    expect(live.writes.length).toBe(writes);
    expect(state.message).toMatch(/nothing/i);
    ctl.setTarget(-12);
    await ctl.undo();
    expect(rawToDb(live.gain("0:0"))).toBeCloseTo(0);
  });

  it("refuses on a Set with no path", async () => {
    live.setPath = "";
    const ctl = fresh();
    await ctl.analyze();
    await ctl.setLayerTracks([2]);
    await ctl.apply();
    expect(live.writes).toEqual([]);
    expect(state.message).toMatch(/save/i);
  });

  it("refuses before Analyze", async () => {
    await fresh().apply();
    expect(live.writes).toEqual([]);
  });

  it("skips a clip that changed file since Analyze, and says so", async () => {
    const ctl = await ready();
    live.session[0].filePath = "swapped.wav";
    live.session[0].name = "SWAPPED";
    await ctl.apply();
    expect(live.writes.map((w) => w[0])).toEqual(["1:0"]); // its layer goes with it
    expect(state.message).toContain("a.wav");
  });

  it("skips a clip deleted since Analyze, and says so", async () => {
    const ctl = await ready();
    live.session = live.session.filter((c) => c.key !== "1:0");
    await ctl.apply();
    expect(live.writes.map((w) => w[0]).sort()).toEqual(["0:0", "2:0"]);
    expect(state.message).toContain("b.wav");
  });

  it("uses the current gain if it was changed by hand after Analyze", async () => {
    const ctl = await ready();
    live.session[0].rawGain = 0.5; // +4 dB
    await ctl.apply();
    expect(rawToDb(live.gain("0:0"))).toBeCloseTo(-2);
  });

  it("reports a read-back mismatch", async () => {
    const ctl = await ready();
    live.readBack = (raw) => raw + 0.1;
    await ctl.apply();
    expect(state.message).toMatch(/didn't (take|stick)/i);
  });

  it("offers Undo after Apply", async () => {
    const ctl = await ready();
    expect(state.canUndo).toBe(false);
    await ctl.apply();
    expect(state.canUndo).toBe(true);
  });

  it("re-analyzing after Apply reads about 0 dB", async () => {
    const ctl = await ready();
    await ctl.apply();
    await ctl.analyze();
    expect(Math.abs(row("0:0").changeDb!)).toBeLessThan(0.01);
    expect(Math.abs(row("2:0").changeDb!)).toBeLessThan(0.01);
  });
});

describe("undo", () => {
  it("restores exact raw values", async () => {
    live.session[0].rawGain = 0.4000000059604645;
    const ctl = await ready();
    await ctl.apply();
    await ctl.undo();
    expect(live.gain("0:0")).toBe(0.4000000059604645);
    expect(live.gain("1:0")).toBe(0.5);
    expect(live.gain("2:0")).toBe(0.3);
    expect(state.canUndo).toBe(false);
  });

  it("steps back through Applies", async () => {
    const ctl = await ready();
    await ctl.apply();
    const afterFirst = live.gain("0:0");
    ctl.setTarget(-16);
    await ctl.apply();
    await ctl.undo();
    expect(live.gain("0:0")).toBeCloseTo(afterFirst, 9);
    await ctl.undo();
    expect(live.gain("0:0")).toBe(0.4);
  });

  it("skips and lists a clip that no longer matches, and restores the rest", async () => {
    const ctl = await ready();
    await ctl.apply();
    live.session[1].filePath = "moved.wav";
    await ctl.undo();
    expect(live.gain("0:0")).toBe(0.4);
    expect(state.message).toContain("b.wav");
    expect(state.canUndo).toBe(false);
  });

  it("works from a fresh Controller after a crash mid-apply", async () => {
    const ctl = await ready();
    live.beforeWrite = (_, n) => { if (n === 1) throw new Error("Live went away"); };
    await ctl.apply();
    expect(state.message).toMatch(/undo/i);
    live.beforeWrite = () => {};

    const after = fresh();
    await after.start();
    expect(state.canUndo).toBe(true);
    await after.undo();
    expect(live.gain("0:0")).toBe(0.4);
    expect(live.gain("1:0")).toBe(0.5);
    expect(live.gain("2:0")).toBe(0.3);
  });

  it("with nothing to undo says so", async () => {
    const ctl = await ready();
    await ctl.undo();
    expect(state.message).toMatch(/nothing to undo/i);
    expect(live.writes).toEqual([]);
  });

  it("a failed undo keeps its snapshot", async () => {
    const ctl = await ready();
    await ctl.apply();
    live.readBack = () => 0.9;
    await ctl.undo();
    expect(state.canUndo).toBe(true);
    expect(state.message).toMatch(/undo again|try/i);
    live.readBack = (raw) => raw;
    await ctl.undo();
    expect(live.gain("0:0")).toBe(0.4);
    expect(state.canUndo).toBe(false);
  });

  it("a write failing during undo keeps its snapshot", async () => {
    const ctl = await ready();
    await ctl.apply();
    live.beforeWrite = () => { throw new Error("nope"); };
    await ctl.undo();
    expect(state.canUndo).toBe(true);
  });

  it("uses this Set's snapshots only", async () => {
    const ctl = await ready();
    await ctl.apply();
    live.setPath = "/sets/Other.als";
    const writes = live.writes.length;
    const other = fresh();
    await other.start();
    await other.undo();
    expect(live.writes.length).toBe(writes);
  });
});

describe("the message line", () => {
  it("clears when the owner changes something after Apply", async () => {
    const ctl = await ready();
    await ctl.apply();
    expect(state.message).not.toBe("");
    ctl.setTarget(-14);
    expect(state.message).toBe("");
  });
});
