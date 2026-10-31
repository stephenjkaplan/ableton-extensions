import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRoles, suggestHost, type Role } from "../src/roles.js";
import type { ArrangementClip, LiveScan, SessionClip } from "../src/types.js";

const halloween: LiveScan = JSON.parse(readFileSync(new URL("./fixtures/halloween-layout.json", import.meta.url), "utf8"));
const layerTracks = [halloween.layerCandidates.find((c) => c.trackName.startsWith("TRACK C"))!.trackIndex];
const byName = (n: string) => halloween.session.find((c) => c.name.startsWith(n))!;

function clip(key: string, filePath: string): SessionClip {
  const [trackIndex, slotIndex] = key.split(":").map(Number);
  return { key, trackIndex, slotIndex, trackName: `T${trackIndex}`, name: filePath, filePath, rawGain: 0.4, warping: true,
           loopStart: 0, loopEnd: 8, warpMarkers: [] };
}
const arr = (filePath: string, start: number, end: number): ArrangementClip => ({ filePath, start, end });
const scan = (session: SessionClip[], arrangement: ArrangementClip[]): LiveScan =>
  ({ setPath: "/s.als", session, arrangement, layerCandidates: [] });

describe("host suggestions on Halloween", () => {
  it.each([
    ["SEVEN DAYS VOCAL SAMPLES", "EPHEWHEN CAY"],
    ["GET BUSY", "EPHEWHEN CAY"],
    ["A YOUNGER ME VOCAL SAMPLES", "TWO GUYS"],
    ["EMPTY WITHOUT MUSIC VOX 1", "DEFUNK HEAD NOD"],
    ["EMPTY WITHOUT MUSIC VOX 2", "DEFUNK HEAD NOD"],
    ["SPACE TUNNEL BUILD 2", "DEFUNK HEAD NOD"],
    ["OPEN THAT DOOR VOCAL", "INTO INFINITY"],
    ["Aye Aye Kaptain", "WHERE TROUBLES MELT"],
  ])("suggests %s on %s", (layer, host) => {
    expect(suggestHost(byName(layer), halloween, layerTracks)).toBe(byName(host).key);
  });

  it.each(["DAYS GO BY VOX SAMPLES", "SPACE TUNNEL BUILD 1"])("%s is a tie, so no suggestion", (layer) => {
    expect(suggestHost(byName(layer), halloween, layerTracks)).toBeNull();
  });
});

describe("suggestHost", () => {
  const layer = clip("2:0", "vox.wav");

  it("picks the file it overlaps most", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav"), layer],
      [arr("vox.wav", 0, 10), arr("a.wav", 0, 3), arr("b.wav", 3, 10)]);
    expect(suggestHost(layer, s, [2])).toBe("1:0");
  });

  it("adds up overlap across several Arrangement clips", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav"), layer],
      [arr("vox.wav", 0, 10), arr("a.wav", 0, 2), arr("a.wav", 4, 8), arr("b.wav", 8, 13)]);
    expect(suggestHost(layer, s, [2])).toBe("0:0");
  });

  it("no suggestion when two are within a beat", () => {
    const s = scan([clip("0:0", "a.wav"), clip("1:0", "b.wav"), layer],
      [arr("vox.wav", 0, 10), arr("a.wav", 0, 5.5), arr("b.wav", 5, 10)]);
    expect(suggestHost(layer, s, [2])).toBeNull();
  });

  it("no suggestion when the best file has two non-layer Session clips", () => {
    const s = scan([clip("0:0", "a.wav"), clip("0:1", "a.wav"), layer], [arr("vox.wav", 0, 10), arr("a.wav", 0, 10)]);
    expect(suggestHost(layer, s, [2])).toBeNull();
  });

  it("no suggestion for a clip not in Arrangement", () => {
    expect(suggestHost(layer, scan([clip("0:0", "a.wav"), layer], [arr("a.wav", 0, 10)]), [2])).toBeNull();
  });

  it("ignores files that aren't non-layer Session clips", () => {
    const s = scan([clip("0:0", "a.wav"), layer, clip("2:1", "other-vox.wav")],
      [arr("vox.wav", 0, 10), arr("stem.wav", 0, 10), arr("other-vox.wav", 0, 10), arr("a.wav", 0, 2)]);
    expect(suggestHost(layer, s, [2])).toBe("0:0");
  });
});

describe("resolveRoles", () => {
  const session = [clip("0:0", "a.wav"), clip("1:0", "b.wav"), clip("2:0", "vox.wav"), clip("2:1", "vox2.wav")];
  const s = scan(session, [arr("vox.wav", 0, 10), arr("a.wav", 0, 10)]);

  it("non-layer lanes start as tracks, layer lanes as layers", () => {
    const r = resolveRoles(s, [2], {});
    expect(r.get("0:0")).toEqual({ kind: "track" });
    expect(r.get("2:0")).toEqual({ kind: "layer", host: "0:0" });
    expect(r.get("2:1")).toEqual({ kind: "layer", host: null });
  });

  it("an answer beats a suggestion", () => {
    expect(resolveRoles(s, [2], { "2:0": { kind: "layer", host: "1:0" } }).get("2:0")).toEqual({ kind: "layer", host: "1:0" });
  });

  it("a layer lane's clip can be its own track, as when Track C is a third track", () => {
    expect(resolveRoles(s, [2], { "2:0": { kind: "track" } }).get("2:0")).toEqual({ kind: "track" });
  });

  it("a saved host that's gone goes back to needing an answer", () => {
    expect(resolveRoles(s, [2], { "2:1": { kind: "layer", host: "9:9" } }).get("2:1")).toEqual({ kind: "layer", host: null });
  });

  it.each<[string, Role]>([["a layer", { kind: "layer", host: "1:0" }], ["left alone", { kind: "leave" }]])(
    "a host that became %s goes back to needing an answer", (_, role) => {
      const r = resolveRoles(s, [2], { "0:0": role, "2:1": { kind: "layer", host: "0:0" } });
      expect(r.get("2:1")).toEqual({ kind: "layer", host: null });
    });

  it("a suggestion can't point at a clip the owner made a layer", () => {
    expect(resolveRoles(s, [2], { "0:0": { kind: "leave" } }).get("2:0")).toEqual({ kind: "layer", host: null });
  });
});
