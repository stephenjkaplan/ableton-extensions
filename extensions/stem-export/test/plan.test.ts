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

describe("buildPlan", () => {
  it("emits stems, then master, then extras", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } },
                       extras: [{ name: "Kick & Snare", trackKeys: ["Kick"] }] }));
    expect(p.map((x) => x.kind)).toEqual(["stem", "stem", "master", "extra"]);
  });

  it("exclusion is the complement of inclusion", () => {
    const drums = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                    Backing: { trackKeys: [], computed: true } } }))[0];
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
    expect(p[0].outputName).toBe("Learning to Feel (Arturia - Played) Jup Sync Lead.wav");
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
    const s = snapshotSong(silent, man.song);
    const p = buildPlan(s, man, resolve(man, s));
    expect(p.filter((x) => x.kind === "stem")).toEqual([]);
    expect(p.some((x) => x.kind === "master")).toBe(true);
  });

  it("Backing includes exactly the unclaimed tracks", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    expect(p[1].include).toEqual(["Bass"]);
  });
});
