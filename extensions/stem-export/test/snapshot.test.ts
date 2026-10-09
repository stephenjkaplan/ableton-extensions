import { describe, expect, it } from "vitest";
import { PRE_MIXER_TAPS, snapshotSong, type TrackLike } from "../src/snapshot.js";

function mk(name: string, group: TrackLike | null = null, opts: Partial<TrackLike> = {}): TrackLike {
  return { name, mute: false, groupTrack: group, devices: [], ...opts };
}

describe("snapshotSong", () => {
  it("derives group tracks from groupTrack back-references", () => {
    const drums = mk("Drums");
    const kick = mk("Kick", drums);
    const s = snapshotSong({ tracks: [drums, kick], mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Drums")!.isGroup).toBe(true);
    expect(s.byKey.get("Drums/Kick")!.isGroup).toBe(false);
  });

  it("builds the group path", () => {
    const drums = mk("Drums");
    const sc = mk("Sidechained", drums);
    const cam = mk("Cam Drums", sc);
    const s = snapshotSong({ tracks: [drums, sc, cam], mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Drums/Sidechained/Cam Drums")!.groupPath).toEqual(["Drums", "Sidechained"]);
  });

  it("disambiguates duplicate names with an ordinal", () => {
    // Review Focus 1: Learning to Feel really has two tracks named "Acid V MIDI".
    const arps = mk("Arps");
    const a1 = mk("Acid V MIDI", arps);
    const a2 = mk("Acid V MIDI", arps);
    const s = snapshotSong({ tracks: [arps, a1, a2], mainTrack: mk("Main") }, "Song");
    expect([...s.byKey.keys()]).toContain("Arps/Acid V MIDI#1");
    expect([...s.byKey.keys()]).toContain("Arps/Acid V MIDI#2");
  });

  it("does not add an ordinal to unique names", () => {
    const s = snapshotSong({ tracks: [mk("Bass")], mainTrack: mk("Main") }, "Song");
    expect([...s.byKey.keys()]).toEqual(["Bass"]);
  });

  it("keys are stable across a re-snapshot of the same set", () => {
    // Review Focus 1: identity must survive a reload, which handles cannot.
    const build = () => {
      const arps = mk("Arps");
      return { tracks: [arps, mk("Acid V MIDI", arps), mk("Acid V MIDI", arps)], mainTrack: mk("Main") };
    };
    const a = snapshotSong(build(), "Song");
    const b = snapshotSong(build(), "Song");
    expect([...a.byKey.keys()]).toEqual([...b.byKey.keys()]);
  });

  it("audible excludes groups and author-muted tracks", () => {
    const drums = mk("Drums");
    const s = snapshotSong(
      { tracks: [drums, mk("Kick", drums), mk("Snare", drums, { mute: true }), mk("Bass")],
        mainTrack: mk("Main") }, "Song");
    expect(s.tracks.filter(t => t.audible).map(t => t.name)).toEqual(["Kick", "Bass"]);
  });

  it("captures device names and master device state", () => {
    const main = mk("Main", null, { devices: [{ name: "Limiter" }] });
    const grp = mk("Arps", null, { devices: [{ name: "GlueCompressor" }] });
    const s = snapshotSong({ tracks: [grp, mk("Acid", grp)], mainTrack: main }, "Song");
    expect(s.byKey.get("Arps")!.devices).toEqual(["GlueCompressor"]);
    expect(s.masterDevices).toEqual([{ name: "Limiter", enabled: true }]);
  });

  it("descendantsOf returns the whole subtree", () => {
    const drums = mk("Drums");
    const sc = mk("Sidechained", drums);
    const s = snapshotSong(
      { tracks: [drums, sc, mk("Cam Drums", sc), mk("Bass")], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums").map(t => t.name)).toEqual(["Sidechained", "Cam Drums"]);
  });

  it("does not treat a name-prefixed sibling group as a child", () => {
    // "Drums A" / "Drums B" is the live set's own naming style; a joined-string
    // prefix match would make B's children look like A's.
    const a = mk("Drums A");
    const b = mk("Drums B");
    const s = snapshotSong(
      { tracks: [a, mk("Kick", a), b, mk("Shaker", b)], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums A").map((t) => t.name)).toEqual(["Kick"]);
  });

  it("exports the pre-mixer tap set", () => {
    expect([...PRE_MIXER_TAPS].sort()).toEqual(["Post FX", "Pre FX"]);
  });
});
