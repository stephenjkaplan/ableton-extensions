import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchManifests, pruneStale } from "../src/mapping-core.js";
import { emptyManifest, type Manifest } from "../src/manifest-core.js";
import { snapshotFromData, snapshotSong, snapshotToData, type SongSnapshot, type TrackLike } from "../src/snapshot.js";

const mk = (name: string, group: TrackLike | null = null, mute = false): TrackLike =>
  ({ name, mute, groupTrack: group, devices: [{ name: "EQ" }] });

/** Nested groups, same-named sibling groups, same-named siblings, a muted group, and a lookalike name. */
function sampleSet(): SongSnapshot {
  const drums = mk("Drums");
  const kick = mk("Kick", drums);
  const g1 = mk("Grp", drums);          // two same-named groups under Drums -> Grp#1, Grp#2
  const g2 = mk("Grp", drums);
  const k1 = mk("Kick", g1);
  const k2 = mk("Kick", g2);
  const dup1 = mk("Snare", drums);      // same-named siblings, not groups
  const dup2 = mk("Snare", drums);
  const muted = mk("Muted", null, true);
  const mutedKid = mk("Kid", muted);
  const lookalike = mk("Drums/Bell");   // top-level track whose name looks like a path under Drums
  const drumsB = mk("Drums B");
  const bKid = mk("Kick", drumsB);
  const topKick = mk("Kick");           // a top-level leaf beside a group that is also named Kick
  const kickGroup = mk("Kick");
  const underKick = mk("Hat", kickGroup);
  const slashed = mk("Kick/Snare");     // a leaf whose own name contains a slash
  const hashed = mk("A#1");             // a group whose name looks like an ordinal suffix
  const hashedKid = mk("Pad", hashed);
  const song = {
    tracks: [drums, kick, g1, k1, g2, k2, dup1, dup2, muted, mutedKid, lookalike, drumsB, bKid,
      topKick, kickGroup, underKick, slashed, hashed, hashedKid],
    mainTrack: { ...mk("Main"), devices: [{ name: "Limiter", enabled: false }, { name: "Glue" }] },
  };
  return snapshotSong(song, "Song");
}

describe("snapshot data round trip", () => {
  it("rebuilds tracks, master devices, byKey and descendantsOf for every key", () => {
    const s = sampleSet();
    const r = snapshotFromData(snapshotToData(s));
    expect(r.song).toBe(s.song);
    expect(r.tracks).toEqual(s.tracks);
    expect(r.masterDevices).toEqual(s.masterDevices);
    expect([...r.byKey.keys()]).toEqual([...s.byKey.keys()]);
    for (const t of s.tracks) {
      expect(r.byKey.get(t.key)).toEqual(t);
      expect(r.descendantsOf(t.key).map((x) => x.key)).toEqual(s.descendantsOf(t.key).map((x) => x.key));
    }
    expect(r.descendantsOf("no such key")).toEqual([]);
  });

  it("keeps same-named sibling groups apart", () => {
    const r = snapshotFromData(snapshotToData(sampleSet()));
    expect(r.byKey.has("Drums/Grp#1")).toBe(true);
    expect(r.byKey.has("Drums/Grp#2")).toBe(true);
    expect(r.descendantsOf("Drums/Grp#1").map((t) => t.key)).toEqual(["Drums/Grp#1/Kick"]);
    expect(r.descendantsOf("Drums/Grp#2").map((t) => t.key)).toEqual(["Drums/Grp#2/Kick"]);
  });

  it("does not take Drums B's children, or a track named like a path, for Drums' descendants", () => {
    const r = snapshotFromData(snapshotToData(sampleSet()));
    const keys = r.descendantsOf("Drums").map((t) => t.key);
    expect(keys).toContain("Drums/Kick");
    expect(keys).toContain("Drums/Grp#2/Kick");
    expect(keys).not.toContain("Drums B/Kick");
    expect(keys).not.toContain("Drums/Bell");
  });

  it("carries a muted group's effective mute down to its children", () => {
    const r = snapshotFromData(snapshotToData(sampleSet()));
    expect(r.descendantsOf("Muted").map((t) => [t.key, t.effectiveMuted])).toEqual([["Muted/Kid", true]]);
  });

  it("survives a JSON round trip unchanged", () => {
    const data = snapshotToData(sampleSet());
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("does not share arrays with the snapshot it came from", () => {
    const s = sampleSet();
    const data = snapshotToData(s);
    data.tracks[1]!.devices = [];
    expect(s.tracks[1]!.devices).toEqual(["EQ"]);
  });
});

describe("pruneStale", () => {
  const snap = () => sampleSet();
  const base = (): Manifest => ({
    ...emptyManifest("Song"),
    stems: {
      Drums: { trackKeys: ["Drums/Kick", "Gone", "Drums"], suffix: "d" },
      Bass: { trackKeys: ["Gone", "Muted/Kid", "Muted"] },
      Backing: { trackKeys: [], computed: true },
    },
    extras: [{ name: "Ex", trackKeys: ["Drums/Grp#1/Kick", "Gone2", "Drums B"] }],
  });

  it("drops a missing key", () => {
    expect(pruneStale(base(), snap()).manifest.stems.Drums!.trackKeys).not.toContain("Gone");
  });

  it("drops a group key", () => {
    const { manifest, dropped } = pruneStale(base(), snap());
    expect(manifest.stems.Drums!.trackKeys).toEqual(["Drums/Kick"]);
    expect(dropped).toContain("Drums");
  });

  it("keeps a muted-but-present key (a held-out track), and drops the muted group itself", () => {
    const { manifest } = pruneStale(base(), snap());
    expect(manifest.stems.Bass!.trackKeys).toEqual(["Muted/Kid"]);
  });

  it("prunes extras too", () => {
    const { manifest, dropped } = pruneStale(base(), snap());
    expect(manifest.extras).toEqual([{ name: "Ex", trackKeys: ["Drums/Grp#1/Kick"] }]);
    expect(dropped).toContain("Gone2");
    expect(dropped).toContain("Drums B");
  });

  it("reports each dropped key once, in first-seen order", () => {
    expect(pruneStale(base(), snap()).dropped).toEqual(["Gone", "Drums", "Muted", "Gone2", "Drums B"]);
  });

  it("leaves Backing computed and keeps other stem fields", () => {
    const { manifest } = pruneStale(base(), snap());
    expect(manifest.stems.Backing).toEqual({ trackKeys: [], computed: true });
    expect(manifest.stems.Drums!.suffix).toBe("d");
  });

  it("does not mutate its input", () => {
    const b = base();
    const copy = JSON.parse(JSON.stringify(b));
    pruneStale(b, snap());
    expect(b).toEqual(copy);
  });
});

describe("browser bundle", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  it("bundles the validator and its helpers for a browser with no node: import", async () => {
    const result = await build({
      stdin: {
        contents: `
          export { validate } from "./validate.js";
          export { resolve } from "./manifest-core.js";
          export { buildPlan } from "./plan.js";
          export { check, manifestFromResponse, pruneStale } from "./mapping-core.js";
          export { snapshotFromData } from "./snapshot.js";
          export { DEFAULT_REGISTRY } from "./default-registry.js";
        `,
        resolveDir: srcDir,
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    const out = result.outputFiles[0]!.text;
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("node:");
  });

  it("does fail when a node: module is in the graph (the check can see one)", async () => {
    await expect(build({
      stdin: { contents: `export { loadManifest } from "./manifest.js";`, resolveDir: srcDir, loader: "ts" },
      bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent",
    })).rejects.toThrow(/node:/);
  });
});

describe("matchManifests", () => {
  const flat = (...names: string[]): SongSnapshot =>
    snapshotSong({ tracks: names.map((n) => mk(n)), mainTrack: mk("Main") }, "S");
  const saved = (name: string, keys: string[], mtimeMs = 1, extras: string[] = []) => {
    const m = emptyManifest(name);
    m.stems.Drums = { trackKeys: keys };
    if (extras.length) m.extras = [{ name: "X", trackKeys: extras }];
    return { name, manifest: m, mtimeMs };
  };

  it("the best overlap wins", () => {
    const snap = flat("A", "B", "C", "D", "E");
    const r = matchManifests([saved("two", ["A", "B"]), saved("four", ["A", "B", "C", "D"]), saved("three", ["A", "B", "C"])], snap)!;
    expect(r.name).toBe("four");
    expect([r.matched, r.total]).toEqual([4, 4]);
  });

  it("fewer than two matched tracks is never eligible, even at 100 percent", () => {
    expect(matchManifests([saved("one", ["A"])], flat("A", "B"))).toBeNull();
  });

  it("below 60 percent is ineligible; exactly 60 percent is eligible", () => {
    const snap = flat("A", "B", "C");
    expect(matchManifests([saved("under", ["A", "B", "C", "x", "y", "z"])], snap)).toBeNull();      // 3 of 6
    expect(matchManifests([saved("under", ["A", "B", "x", "y"])], snap)).toBeNull();                 // 2 of 4
    expect(matchManifests([saved("edge", ["A", "B", "C", "x", "y"])], snap)!.name).toBe("edge");     // 3 of 5
  });

  it("a tie on matches goes to the newer file, whatever the order", () => {
    const snap = flat("A", "B");
    expect(matchManifests([saved("old", ["A", "B"], 1), saved("new", ["A", "B"], 2)], snap)!.name).toBe("new");
    expect(matchManifests([saved("new", ["A", "B"], 2), saved("old", ["A", "B"], 1)], snap)!.name).toBe("new");
  });

  it("group keys and missing keys do not count as matched", () => {
    const grp = mk("G");
    const snap = snapshotSong({ tracks: [grp, mk("A", grp), mk("B")], mainTrack: mk("Main") }, "S");
    // "G" is a group, "G/A" and "B" are tracks, "Gone" is absent: 2 of 4 matched is under 60 percent.
    expect(matchManifests([saved("m", ["G", "G/A", "B", "Gone"])], snap)).toBeNull();
    const r = matchManifests([saved("m", ["G", "G/A", "B"])], snap)!;
    expect([r.matched, r.total]).toEqual([2, 3]);
  });

  it("total counts distinct keys across stems AND extras, each once", () => {
    const m = saved("m", ["A", "B"], 1, ["B", "C", "x"]);
    m.manifest.stems.Keys = { trackKeys: ["A"] };
    const r = matchManifests([m], flat("A", "B", "C"))!;
    expect([r.matched, r.total]).toEqual([3, 4]);
  });

  it("a muted track still counts as matched", () => {
    const snap = snapshotSong({ tracks: [mk("A", null, true), mk("B", null, true)], mainTrack: mk("Main") }, "S");
    expect(matchManifests([saved("m", ["A", "B"])], snap)!.matched).toBe(2);
  });

  it("another song's generic names that the Set shares two of, under 60 percent, do not match", () => {
    const other = saved("Other Song", ["Kick", "Bass", "Lead", "Pad", "Vox", "Snare", "Hat"]);
    expect(matchManifests([other], flat("Kick", "Bass", "Strings", "Cello"))).toBeNull();   // 2 of 7
  });

  it("returns null for no saved mappings", () => {
    expect(matchManifests([], flat("A", "B"))).toBeNull();
  });

  it("does not mutate its input", () => {
    const list = [saved("a", ["A", "B", "x"], 1, ["A"]), saved("b", ["A", "B"], 2)];
    const before = JSON.stringify(list);
    matchManifests(list, flat("A", "B"));
    expect(JSON.stringify(list)).toBe(before);
  });
});
