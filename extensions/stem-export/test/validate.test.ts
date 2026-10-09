import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY as R } from "../src/default-registry.js";
import { emptyManifest, resolve, type Manifest } from "../src/manifest.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import { blocking, validate, type KeyTap } from "../src/validate.js";

const mk = (name: string, g: TrackLike | null = null, mute = false,
            devices: { name: string }[] = []): TrackLike =>
  ({ name, mute, groupTrack: g, devices });

const withStems = (stems: Manifest["stems"]): Manifest => ({ ...emptyManifest("Song"), stems });
const rules = (f: ReturnType<typeof validate>, sev?: string) =>
  new Set(f.filter((x) => !sev || x.severity === sev).map((x) => x.rule));

function run(song: Parameters<typeof snapshotSong>[0], m: Manifest, taps: readonly KeyTap[] = []) {
  const s = snapshotSong(song, "Song");
  return validate(s, m, resolve(m, s), R, taps);
}

describe("validate", () => {
  it("flags an enabled master device and blocks", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main", null, false, [{ name: "Limiter" }]) },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "error")).toContain("master-live");
    expect(blocking(f).length).toBeGreaterThan(0);
  });

  it("reports a clean master", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "ok")).toContain("master-clean");
  });

  it("flags a named stem that would render silent, and only that stem", () => {
    const f = run({ tracks: [mk("Bass", null, true), mk("Pad")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] }, Backing: { trackKeys: [], computed: true } }));
    const hits = f.filter((x) => x.rule === "empty-stem");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("error");
    expect(hits[0].detail).toContain("'Drums'");
  });

  it("does not flag an empty Backing when every audible track is assigned", () => {
    const f = run({ tracks: [mk("Kick")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] }, Backing: { trackKeys: [], computed: true } }));
    expect(f.filter((x) => x.rule === "empty-stem")).toEqual([]);
  });

  it("flags an unknown stem name and suggests a fix", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ "Organ - Playedl": { trackKeys: ["Bass"] } }));
    const hit = f.find((x) => x.rule === "unknown-stem")!;
    expect(hit.detail).toContain("Did you mean 'Organ - Played'?");
  });

  it("suggests a fix for the Sub37- Played typo", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ "Sub37- Played": { trackKeys: ["Bass"] } }));
    const hit = f.find((x) => x.rule === "unknown-stem")!;
    expect(hit.detail).toContain("Did you mean 'Sub37 - Played'?");
  });

  it("gives no suggestion when nothing is close", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ "Zzzzzzzzzz": { trackKeys: ["Bass"] } }));
    expect(f.find((x) => x.rule === "unknown-stem")!.detail).not.toContain("Did you mean");
  });

  it("warns when a processed group is split across stems", () => {
    const arps = mk("Arps", null, false, [{ name: "GlueCompressor" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid"] },
                  "Sub37 - Backing": { trackKeys: ["Arps/Pluck"] } }));
    const hit = f.find((x) => x.rule === "split-group")!;
    expect(hit.severity).toBe("warn");
    expect(hit.detail).toContain("Arps");
    expect(hit.detail).toContain("GlueCompressor");
  });

  it("does not warn when a processed group lands wholly in one stem", () => {
    const arps = mk("Arps", null, false, [{ name: "GlueCompressor" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid", "Arps/Pluck"] } }));
    expect(rules(f, "warn")).not.toContain("split-group");
  });

  it("flags a Post Mixer key source excluded from a pass", () => {
    const f = run({ tracks: [mk("Kick"), mk("Sub")], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] }, "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post Mixer" }]);
    const hit = f.find((x) => x.rule === "post-mixer-key")!;
    expect(hit.severity).toBe("error");
    expect(hit.detail).toContain("Kick");
  });

  it("does not flag pre-mixer taps", () => {
    const f = run({ tracks: [mk("Kick"), mk("Sub")], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] }, "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post FX" }]);
    expect(rules(f, "error")).not.toContain("post-mixer-key");
  });

  it("reports Backing fall-through and held-out mutes", () => {
    const f = run({ tracks: [mk("Kick"), mk("Bass"), mk("Old Idea", null, true)],
                    mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] } }));
    expect(f.find((x) => x.rule === "backing-fallthrough")!.detail).toContain("Bass");
    expect(f.find((x) => x.rule === "muted-held-out")!.detail).toContain("Old Idea");
  });

  it("lists same-named Backing fall-through tracks by key", () => {
    const f = run({ tracks: [mk("Kick"), mk("Chem Bros 3"), mk("Chem Bros 3")],
                    mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] } }));
    const d = f.find((x) => x.rule === "backing-fallthrough")!.detail;
    expect(d).toContain("Chem Bros 3#1");
    expect(d).toContain("Chem Bros 3#2");
  });

  it("blocking returns only errors", () => {
    const f = run({ tracks: [mk("Bass"), mk("Old Idea", null, true)],
                    mainTrack: mk("Main", null, false, [{ name: "X" }]) },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    // The scenario must contain non-errors for the filter to be meaningful.
    expect(f.some((x) => x.severity === "info")).toBe(true);
    expect(f.some((x) => x.severity === "error")).toBe(true);
    const b = blocking(f);
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThan(f.length);
    expect(b.every((x) => x.severity === "error")).toBe(true);
  });

  it("blocking also drops warnings", () => {
    const arps = mk("Arps", null, false, [{ name: "Glue" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid"] },
                  "Sub37 - Backing": { trackKeys: ["Arps/Pluck"] } }));
    expect(rules(f, "warn")).toContain("split-group");
    expect(blocking(f).some((x) => x.severity === "warn")).toBe(false);
  });

  it("errors once per double-claimed track", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] }, "Serum - Played": { trackKeys: ["Bass"] } }));
    const hits = f.filter((x) => x.rule === "double-claimed");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("error");
    expect(hits[0].detail).toContain("Bass");
  });

  it("errors on an unresolved track reference", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass", "Ghost"] } }));
    const hits = f.filter((x) => x.rule === "unresolved-ref");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("error");
    expect(hits[0].detail).toContain("Ghost");
  });

  it("warns when more instruments are used than deck slots", () => {
    const insts = R.instruments.slice(0, R.instrumentSlotsPerDeck + 1);
    const stems: Manifest["stems"] = {};
    for (const i of insts) stems[`${i.name} - Played`] = { trackKeys: ["Bass"] };
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") }, withStems(stems));
    expect(f.find((x) => x.rule === "slot-overflow")!.severity).toBe("warn");
  });

  it("does not warn at exactly the slot limit, or count Played/Backing twice", () => {
    const insts = R.instruments.slice(0, R.instrumentSlotsPerDeck);
    const stems: Manifest["stems"] = {};
    for (const i of insts) {
      stems[`${i.name} - Played`] = { trackKeys: ["Bass"] };
      stems[`${i.name} - Backing`] = { trackKeys: [] };
    }
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") }, withStems(stems));
    expect(rules(f)).not.toContain("slot-overflow");
  });

  it("ignores disabled master devices", () => {
    const song = { tracks: [mk("Bass")], mainTrack: mk("Main") };
    const m = withStems({ Drums: { trackKeys: ["Bass"] } });
    const s = snapshotSong(song, "Song");
    const s2 = { ...s, masterDevices: [{ name: "X", enabled: false }] };
    const f = validate(s2, m, resolve(m, s2), R, []);
    expect(rules(f)).toContain("master-clean");
    expect(rules(f)).not.toContain("master-live");
  });

  it("does not flag a Post Mixer tap when the key track is muted", () => {
    const f = run({ tracks: [mk("Kick", null, true), mk("Sub")], mainTrack: mk("Main") },
      withStems({ "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post Mixer" }]);
    expect(rules(f, "error")).not.toContain("post-mixer-key");
  });

  it("emits one post-mixer finding per tap, naming every offending stem", () => {
    const grp = mk("Layers");
    const f = run({ tracks: [mk("Kick"), grp, mk("A", grp), mk("B", grp)], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] },
                  "Serum - Played": { trackKeys: ["Layers/A"] },
                  "Serum - Backing": { trackKeys: ["Layers/B"] } }),
      [{ trackKey: "Layers", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post Mixer" }]);
    const hits = f.filter((x) => x.rule === "post-mixer-key");
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("'Serum - Played'");
    expect(hits[0].detail).toContain("'Serum - Backing'");
  });

  it("counts unassigned descendants as Backing for split-group", () => {
    const arps = mk("Arps", null, false, [{ name: "GlueCompressor" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid"] } }));
    const hit = f.find((x) => x.rule === "split-group")!;
    expect(hit.detail).toContain("Backing");
    expect(hit.detail).toContain("Arturia - Backing");
  });

  it("distinguishes same-named muted tracks by key", () => {
    const f = run({ tracks: [mk("Kick"), mk("Audio", null, true), mk("Audio", null, true)],
                    mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] } }));
    const d = f.find((x) => x.rule === "muted-held-out")!.detail;
    expect(d).toContain("Audio#1");
    expect(d).toContain("Audio#2");
  });

  it("warns when an extra references unknown keys", () => {
    const m = { ...emptyManifest("Song"),
                stems: { Drums: { trackKeys: ["Kick"] } },
                extras: [{ name: "Bad", trackKeys: ["Ghost", "Kick"] }] };
    const f = run({ tracks: [mk("Kick"), mk("Bass")], mainTrack: mk("Main") }, m);
    const hits = f.filter((x) => x.rule === "extras-unresolved");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warn");
    expect(hits[0].detail).toContain("Bad");
    expect(hits[0].detail).toContain("Ghost");
  });

  it("warns when an extra references muted tracks", () => {
    const m = { ...emptyManifest("Song"),
                stems: { Drums: { trackKeys: ["Kick"] } },
                extras: [{ name: "Muted Extra", trackKeys: ["Old Idea"] }] };
    const f = run({ tracks: [mk("Kick"), mk("Old Idea", null, true)], mainTrack: mk("Main") }, m);
    const hits = f.filter((x) => x.rule === "extras-unresolved");
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("Muted Extra");
    expect(hits[0].detail).toContain("Old Idea");
  });

  it("does not warn when all extra keys resolve to audible tracks", () => {
    const m = { ...emptyManifest("Song"),
                stems: { Drums: { trackKeys: ["Kick"] } },
                extras: [{ name: "Good", trackKeys: ["Kick", "Bass"] }] };
    const f = run({ tracks: [mk("Kick"), mk("Bass")], mainTrack: mk("Main") }, m);
    expect(rules(f)).not.toContain("extras-unresolved");
  });
});
