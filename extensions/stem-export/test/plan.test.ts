import { describe, expect, it } from "vitest";
import { emptyManifest, resolve, type Manifest } from "../src/manifest.js";
import { buildPlan } from "../src/plan.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";

const mk = (name: string, g: TrackLike | null = null, mute = false): TrackLike =>
  ({ name, mute, groupTrack: g, devices: [] });

const SONG = { tracks: [mk("Kick"), mk("Bass")], mainTrack: mk("Main") };
const m = (over: Partial<Manifest>): Manifest => ({ ...emptyManifest("Song"), ...over });

function plan(man: Manifest) {
  const s = snapshotSong(SONG, man.song);
  return buildPlan(s, man, resolve(man, s));
}

function planWithSong(song: Parameters<typeof snapshotSong>[0], man: Manifest) {
  const s = snapshotSong(song, man.song);
  return buildPlan(s, man, resolve(man, s));
}

describe("buildPlan", () => {
  it("emits stems, then master, then extras", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } },
                       extras: [{ name: "Kick & Snare", trackKeys: ["Kick"] }] }));
    expect(p.map((x) => x.kind)).toEqual(["stem", "stem", "master", "extra"]);
  });

  it("exclusion is the complement of inclusion", () => {
    const drums = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                    Backing: { trackKeys: [], computed: true } } }))
                         .find((x) => x.name === "Drums")!;
    expect(drums.include).toEqual(["Kick"]);
    expect(drums.exclude).toEqual(["Bass"]);
  });

  it("orders Backing last among stems", () => {
    const p = plan(m({ stems: { Backing: { trackKeys: [], computed: true },
                                Drums: { trackKeys: ["Kick"] } } }));
    expect(p.filter((x) => x.kind === "stem").map((x) => x.name)).toEqual(["Drums", "Backing"]);
  });

  it("the master pass excludes nothing", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    const master = p.find((x) => x.kind === "master")!;
    expect(master.exclude).toEqual([]);
    expect([...master.include].sort()).toEqual(["Bass", "Kick"]);
  });

  it("applies the suffix to stem filenames", () => {
    const p = plan(m({ song: "Learning to Feel",
      stems: { "Arturia - Played": { trackKeys: ["Kick"], suffix: " Jup Sync Lead" },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Kick & Snare", trackKeys: ["Kick"] }] }));
    expect(p.find((x) => x.name === "Arturia - Played")!.outputName)
      .toBe("Learning to Feel (Arturia - Played) Jup Sync Lead.wav");
    expect(p.find((x) => x.kind === "extra")!.outputName)
      .toBe("Learning to Feel (Kick & Snare).wav");
  });

  it("omits the Backing pass when nothing is unclaimed", () => {
    // The validator does not flag an empty Backing, so the planner must not render one.
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick", "Bass"] },
                                Backing: { trackKeys: [], computed: true } } }));
    expect(p.filter((x) => x.kind === "stem").map((x) => x.name)).toEqual(["Drums"]);
  });

  it("produces no stem passes when the set has nothing audible", () => {
    const silent = { tracks: [mk("Kick", null, true)], mainTrack: mk("Main") };
    const man = m({ stems: { Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(silent, man);
    expect(p.filter((x) => x.kind === "stem")).toEqual([]);
    expect(p).toHaveLength(1);
    const master = p[0];
    expect(master.kind).toBe("master");
    expect(master.include).toEqual([]);
    expect(master.exclude).toEqual([]);
  });

  it("includes Backing when unassigned tracks exist", () => {
    const G1 = mk("G1");
    const G2 = mk("G2");
    const groupOnly = { tracks: [mk("L1", G1), mk("L2", G2)], mainTrack: mk("Main") };
    const man = m({ stems: { Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(groupOnly, man);
    const backing = p.find((x) => x.kind === "stem");
    expect(backing?.name).toBe("Backing");
    expect([...backing!.include].sort()).toEqual(["G1/L1", "G2/L2"]);
  });

  it("Backing includes exactly the unclaimed tracks", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    const backing = p.find((x) => x.name === "Backing")!;
    expect(backing.include).toEqual(["Bass"]);
  });

  it("orders multiple stems in manifest order", () => {
    const p = plan(m({ stems: {
      "Serum - Backing": { trackKeys: ["Bass"] },
      "Sub37 - Played": { trackKeys: ["Kick"] },
      Backing: { trackKeys: [], computed: true },
    } }));
    const stems = p.filter((x) => x.kind === "stem").map((x) => x.name);
    expect(stems).toEqual(["Serum - Backing", "Sub37 - Played"]);
  });

  it("include and exclude are disjoint and partition audible", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    for (const pass of p) {
      const incSet = new Set(pass.include);
      const excSet = new Set(pass.exclude);
      for (const k of pass.include) {
        expect(excSet.has(k)).toBe(false);
      }
      expect(incSet.size + excSet.size).toBe(2);
    }
  });

  it("exclude contains no groups or muted tracks", () => {
    const G = mk("G");
    const song = { tracks: [G, mk("L1", G), mk("L2", G), mk("Muted", null, true), mk("Normal")],
                   mainTrack: mk("Main") };
    const man = m({ stems: { Drums: { trackKeys: ["L1"] },
                             Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(song, man);
    const s = snapshotSong(song, "Song");
    const allTracks = new Map(s.tracks.map((t) => [t.key, t]));
    for (const pass of p) {
      for (const k of pass.exclude) {
        const t = allTracks.get(k)!;
        expect(t.isGroup).toBe(false);
        expect(t.muted).toBe(false);
      }
    }
  });

  it("skips extras that resolve to no audible tracks", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Gone", trackKeys: ["Nonexistent"] },
               { name: "Valid", trackKeys: ["Bass"] }],
    }));
    expect(p.filter((x) => x.kind === "extra").map((x) => x.name)).toEqual(["Valid"]);
  });

  it("extras appear in manifest order after master", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Extra A", trackKeys: ["Kick"] },
               { name: "Extra B", trackKeys: ["Bass"] }],
    }));
    const kinds = p.map((x) => x.kind);
    const masterIdx = kinds.indexOf("master");
    expect(kinds.slice(masterIdx + 1)).toEqual(["extra", "extra"]);
    const extras = p.filter((x) => x.kind === "extra");
    expect(extras[0].name).toBe("Extra A");
    expect(extras[1].name).toBe("Extra B");
  });

  it("extras include and exclude correctly", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Both", trackKeys: ["Kick", "Bass"] }],
    }));
    const extra = p.find((x) => x.kind === "extra")!;
    expect(new Set(extra.include).size).toBe(2);
    expect(extra.exclude).toEqual([]);
  });

  it("extras with partially-resolved keys include only audible ones", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Partial", trackKeys: ["Kick", "Ghost", "Bass"] }],
    }));
    const extra = p.find((x) => x.kind === "extra")!;
    expect([...extra.include].sort()).toEqual(["Bass", "Kick"]);
  });
});
