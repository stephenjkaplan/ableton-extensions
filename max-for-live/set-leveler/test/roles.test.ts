import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRoles, type Role } from "../src/roles.js";
import type { ArrangementClip, LiveScan, SessionClip } from "../src/types.js";

const halloween: LiveScan = JSON.parse(readFileSync(new URL("./fixtures/halloween-layout.json", import.meta.url), "utf8"));
const roles = resolveRoles(halloween, {});
const byName = (n: string) => halloween.session.find((c) => c.name.startsWith(n))!;
const roleOf = (n: string) => roles.get(byName(n).key)!;

function clip(key: string, filePath: string): SessionClip {
  const [trackIndex, slotIndex] = key.split(":").map(Number);
  return { key, trackIndex, slotIndex, trackName: `T${trackIndex}`, name: filePath, filePath, rawGain: 0.4, warping: true,
           loopStart: 0, loopEnd: 8, warpMarkers: [] };
}
const arr = (filePath: string, start: number, end: number): ArrangementClip => ({ filePath, start, end });
const scan = (session: SessionClip[], arrangement: ArrangementClip[]): LiveScan => ({ setPath: "/s.als", session, arrangement });

describe("what Arrangement says about Halloween", () => {
  it.each([
    ["HATE IT OR LOVE IT SAMPLES", "5AM UNKNOWN REMIX"], // on Track B, so a per-lane rule missed it
    ["DAYS GO BY INST SAMPLES", "5AM UNKNOWN REMIX"],
    ["OH DANG BUILD", "WHAT YOU NEED"],
    ["BLOCK 2 BLOCK - OUTRO", "WHERE TROUBLES MELT"],
    ["DAYS GO BY VOX SAMPLES", "5AM UNKNOWN REMIX"], // its other overlap is itself a layer, so this is no longer a tie
    ["SEVEN DAYS VOCAL SAMPLES", "EPHEWHEN CAY"],
    ["GET BUSY", "EPHEWHEN CAY"],
    ["A YOUNGER ME VOCAL SAMPLES", "TWO GUYS"],
    ["EMPTY WITHOUT MUSIC VOX 1", "DEFUNK HEAD NOD"],
    ["EMPTY WITHOUT MUSIC VOX 2", "DEFUNK HEAD NOD"],
    ["SPACE TUNNEL BUILD 2", "DEFUNK HEAD NOD"],
    ["OPEN THAT DOOR VOCAL", "INTO INFINITY"],
  ])("%s is a layer on %s", (layer, host) => {
    expect(roleOf(layer)).toEqual({ kind: "layer", host: byName(host).key });
  });

  it("asks about a real tie", () => {
    expect(roleOf("SPACE TUNNEL BUILD 1")).toEqual({ kind: "layer", host: null });
  });

  it.each(["5AM UNKNOWN REMIX", "SEVEN DAYS COMMON CREATION", "TWO GUYS", "CHEZ - COMIN THRU", "WHERE TROUBLES MELT", "DEFUNK HEAD NOD"])(
    "%s is a track", (name) => {
      expect(roleOf(name)).toEqual({ kind: "track" });
    });
});

describe("resolveRoles", () => {
  it("a clip mostly inside a longer one is a layer, on any track", () => {
    const s = scan([clip("0:0", "long.wav"), clip("1:0", "short.wav")], [arr("long.wav", 0, 100), arr("short.wav", 10, 30)]);
    const r = resolveRoles(s, {});
    expect(r.get("0:0")).toEqual({ kind: "track" });
    expect(r.get("1:0")).toEqual({ kind: "layer", host: "0:0" });
  });

  it("two tracks crossing in a transition are both tracks", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav")], [arr("a.wav", 0, 100), arr("b.wav", 70, 180)]);
    const r = resolveRoles(s, {});
    expect(r.get("0:0")).toEqual({ kind: "track" });
    expect(r.get("1:0")).toEqual({ kind: "track" });
  });

  it("a shorter clip only partly inside a longer one stays a track", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav")], [arr("a.wav", 0, 100), arr("b.wav", 80, 120)]);
    expect(resolveRoles(s, {}).get("1:0")).toEqual({ kind: "track" });
  });

  it("the same length isn't a layer", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav")], [arr("a.wav", 0, 100), arr("b.wav", 0, 100)]);
    expect(resolveRoles(s, {}).get("0:0")).toEqual({ kind: "track" });
    expect(resolveRoles(s, {}).get("1:0")).toEqual({ kind: "track" });
  });

  it("picks the track it overlaps most, adding up several placements", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav"), clip("2:0", "vox.wav")],
      [arr("vox.wav", 0, 10), arr("vox.wav", 100, 110), arr("a.wav", 0, 60), arr("a.wav", 100, 160), arr("b.wav", 5, 50)]);
    expect(resolveRoles(s, {}).get("2:0")).toEqual({ kind: "layer", host: "0:0" });
  });

  it("a layer never hosts another layer", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "mid.wav"), clip("2:0", "small.wav")],
      [arr("a.wav", 0, 100), arr("mid.wav", 0, 50), arr("small.wav", 0, 10)]);
    expect(resolveRoles(s, {}).get("2:0")).toEqual({ kind: "layer", host: "0:0" });
  });

  it("asks when the best file has two Session clips", () => {
    const s = scan([clip("0:0", "a.wav"), clip("0:1", "a.wav"), clip("2:0", "vox.wav")], [arr("a.wav", 0, 100), arr("vox.wav", 0, 10)]);
    expect(resolveRoles(s, {}).get("2:0")).toEqual({ kind: "layer", host: null });
  });

  it("asks about a clip that isn't in Arrangement", () => {
    const s = scan([clip("0:0", "a.wav"), clip("2:0", "vox.wav")], [arr("a.wav", 0, 100)]);
    expect(resolveRoles(s, {}).get("2:0")).toEqual({ kind: "layer", host: null });
  });

  it("ignores files that aren't in Session", () => {
    const s = scan([clip("2:0", "vox.wav")], [arr("vox.wav", 0, 10), arr("stem.wav", 0, 100)]);
    expect(resolveRoles(s, {}).get("2:0")).toEqual({ kind: "track" });
  });

  const session = [clip("0:0", "a.wav"), clip("1:0", "b.wav"), clip("2:0", "vox.wav"), clip("2:1", "lost.wav")];
  const s = scan(session, [arr("a.wav", 0, 100), arr("b.wav", 200, 300), arr("vox.wav", 0, 10)]);

  it("an answer beats what Arrangement suggests", () => {
    expect(resolveRoles(s, { "2:0": { kind: "layer", host: "1:0" } }).get("2:0")).toEqual({ kind: "layer", host: "1:0" });
    expect(resolveRoles(s, { "2:0": { kind: "track" } }).get("2:0")).toEqual({ kind: "track" });
  });

  it("a saved host that's gone goes back to needing an answer", () => {
    expect(resolveRoles(s, { "2:1": { kind: "layer", host: "9:9" } }).get("2:1")).toEqual({ kind: "layer", host: null });
  });

  it.each<[string, Role]>([["a layer", { kind: "layer", host: "1:0" }], ["left alone", { kind: "leave" }]])(
    "a host that became %s goes back to needing an answer", (_, role) => {
      const r = resolveRoles(s, { "0:0": role, "2:1": { kind: "layer", host: "0:0" } });
      expect(r.get("2:1")).toEqual({ kind: "layer", host: null });
    });

  it("a suggestion can't point at a clip the owner made something else", () => {
    expect(resolveRoles(s, { "0:0": { kind: "leave" } }).get("2:0")).toEqual({ kind: "layer", host: null });
  });
});
