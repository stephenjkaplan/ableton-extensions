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

  it("leaves out a stem whose tracks are all muted, but the manifest still holds it", () => {
    const song = { tracks: [mk("Kick"), mk("Bass"), mk("Old", null, true)], mainTrack: mk("Main") };
    const man = m({ stems: { Drums: { trackKeys: ["Kick"] }, Keys: { trackKeys: ["Old"] },
                             Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(song, man);
    expect(p.filter((x) => x.kind === "stem").map((x) => x.name)).toEqual(["Drums", "Backing"]);
    expect(p.every((x) => !x.include.includes("Old") && !x.exclude.includes("Old"))).toBe(true);
    expect(man.stems.Keys.trackKeys).toEqual(["Old"]);
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

  it("produces no stem passes when the set has only groups (no audible leaves)", () => {
    // Groups with all descendants muted: groups exist but no audible tracks.
    const G1 = mk("G1");
    const G2 = mk("G2");
    const groupOnly = {
      tracks: [G1, mk("L1", G1, true), G2, mk("L2", G2, true)],
      mainTrack: mk("Main")
    };
    const man = m({ stems: { Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(groupOnly, man);
    expect(p).toHaveLength(1);
    expect(p[0].kind).toBe("master");
    expect(p[0].include).toEqual([]);
    expect(p[0].exclude).toEqual([]);
  });

  it("Backing includes exactly the unclaimed tracks", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    const backing = p.find((x) => x.name === "Backing")!;
    expect(backing.include).toEqual(["Bass"]);
  });

  it("Backing includes grouped leaf tracks", () => {
    const G1 = mk("G1");
    const G2 = mk("G2");
    const song = { tracks: [G1, mk("L1", G1), G2, mk("L2", G2)], mainTrack: mk("Main") };
    const man = m({ stems: { Backing: { trackKeys: [], computed: true } } });
    const p = planWithSong(song, man);
    const backing = p.find((x) => x.name === "Backing")!;
    expect(backing.include.sort()).toEqual(["G1/L1", "G2/L2"]);
  });

  it("extras with partial resolution keep valid keys, drop unresolved ones", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Partial", trackKeys: ["Kick", "Ghost", "Bass"] }],
    }));
    const extra = p.find((x) => x.kind === "extra")!;
    expect([...extra.include].sort()).toEqual(["Bass", "Kick"]);
  });

  it("include and exclude partition audible tracks; exclude has no groups or muted keys", () => {
    // Complex fixture: groups, muted tracks, muted group with unmuted child.
    const G = mk("G");
    const MG = mk("MG", null, true);
    const song = {
      tracks: [
        G, mk("L1", G), mk("L2", G),
        MG, mk("ChildOfMutedGroup", MG),
        mk("Muted", null, true),
        mk("Normal"),
      ],
      mainTrack: mk("Main"),
    };
    const man = m({ stems: {
      "Arturia - Played": { trackKeys: ["G/L1"] },  // Correct key with group path
      Backing: { trackKeys: [], computed: true },
    } });
    const p = planWithSong(song, man);
    const s = snapshotSong(song, "Song");
    const allTracks = new Map(s.tracks.map((t) => [t.key, t]));
    const audibleKeys = s.tracks.filter((t) => t.audible).map((t) => t.key);

    for (const pass of p) {
      // include and exclude are disjoint
      const incSet = new Set(pass.include);
      const excSet = new Set(pass.exclude);
      for (const k of pass.include) {
        expect(excSet.has(k), `${k} in both include and exclude`).toBe(false);
      }
      for (const k of pass.exclude) {
        expect(incSet.has(k), `${k} in both exclude and include`).toBe(false);
      }
      // union equals audible set
      const union = new Set([...pass.include, ...pass.exclude]);
      expect(union.size).toBe(audibleKeys.length);
      for (const k of audibleKeys) {
        expect(union.has(k), `${k} missing from include ∪ exclude`).toBe(true);
      }
      // exclude contains no groups or muted keys
      for (const k of pass.exclude) {
        const t = allTracks.get(k)!;
        expect(t.isGroup, `${k} is a group but in exclude`).toBe(false);
        expect(t.muted, `${k} is muted but in exclude`).toBe(false);
      }
    }
    // Direct assertion: Arturia stem must claim its assigned track (catches key-resolution bugs)
    expect(p.find((x) => x.name === "Arturia - Played")!.include).toEqual(["G/L1"]);
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

  it("extras with subset of audible tracks have non-empty exclude", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "OnlyBass", trackKeys: ["Bass"] }],
    }));
    const extra = p.find((x) => x.kind === "extra")!;
    expect(extra.include).toEqual(["Bass"]);
    expect(extra.exclude).toEqual(["Kick"]);
  });

  it("extras drop muted and group tracks from include", () => {
    const G = mk("G");
    const song = {
      tracks: [G, mk("Child", G), mk("Muted", null, true), mk("Normal")],
      mainTrack: mk("Main"),
    };
    const man = m({
      stems: { Drums: { trackKeys: ["Normal"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "BadExtra", trackKeys: ["G", "Muted", "Normal"] }],
    });
    const p = planWithSong(song, man);
    const extra = p.find((x) => x.kind === "extra")!;
    expect(extra.include).toEqual(["Normal"]);
    expect(extra.exclude).toEqual(["G/Child"]);
  });

  it("extras appear in manifest order after master with correct include/exclude", () => {
    const p = plan(m({
      stems: { Drums: { trackKeys: ["Kick"] },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "A", trackKeys: ["Kick"] },
               { name: "B", trackKeys: ["Bass"] },
               { name: "C", trackKeys: ["Kick", "Bass"] }],
    }));
    const kinds = p.map((x) => x.kind);
    const masterIdx = kinds.indexOf("master");
    expect(kinds.slice(masterIdx + 1)).toEqual(["extra", "extra", "extra"]);
    const extras = p.filter((x) => x.kind === "extra");
    expect(extras[0].name).toBe("A");
    expect(extras[0].include).toEqual(["Kick"]);
    expect(extras[0].exclude).toEqual(["Bass"]);
    expect(extras[1].name).toBe("B");
    expect(extras[1].include).toEqual(["Bass"]);
    expect(extras[1].exclude).toEqual(["Kick"]);
    expect(extras[2].name).toBe("C");
    expect(extras[2].include.sort()).toEqual(["Bass", "Kick"]);
    expect(extras[2].exclude).toEqual([]);
  });

  it("orders three non-alphabetical stems in manifest order and includes Backing last", () => {
    // Three stems in non-alphabetical manifest order: Sub37, Arturia, Organ.
    // If sorted alphabetically it would be: Arturia, Organ, Sub37 — verify manifest order.
    const p = plan(m({
      stems: {
        "Sub37 - Played": { trackKeys: ["Kick"] },
        "Arturia - Backing": { trackKeys: ["Bass"] },
        "Organ - Played": { trackKeys: [] },
        Backing: { trackKeys: [], computed: true },
      },
    }));
    const names = p.filter((x) => x.kind === "stem").map((x) => x.name);
    expect(names).toEqual(["Sub37 - Played", "Arturia - Backing", "Organ - Played"]);

    // Now test with unclaimed track to show Backing appears last
    const p2 = plan(m({
      stems: {
        "Sub37 - Played": { trackKeys: [] },
        "Arturia - Backing": { trackKeys: ["Kick"] },
        "Organ - Played": { trackKeys: [] },
        Backing: { trackKeys: [], computed: true },
      },
    }));
    const names2 = p2.filter((x) => x.kind === "stem").map((x) => x.name);
    expect(names2).toEqual(["Sub37 - Played", "Arturia - Backing", "Organ - Played", "Backing"]);
  });
});
