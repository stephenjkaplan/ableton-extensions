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

  it("disambiguates duplicate names with an ordinal, in track order", () => {
    // Review Focus 1: Learning to Feel really has two tracks named "Acid V MIDI".
    const arps = mk("Arps");
    const a1 = mk("Acid V MIDI", arps, { devices: [{ name: "A" }] });
    const a2 = mk("Acid V MIDI", arps, { devices: [{ name: "B" }] });
    const s = snapshotSong({ tracks: [arps, a1, a2], mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Arps/Acid V MIDI#1")!.devices).toEqual(["A"]);
    expect(s.byKey.get("Arps/Acid V MIDI#2")!.devices).toEqual(["B"]);
  });

  it("does not add an ordinal to unique names", () => {
    const s = snapshotSong({ tracks: [mk("Bass")], mainTrack: mk("Main") }, "Song");
    expect([...s.byKey.keys()]).toEqual(["Bass"]);
  });

  it("keys are stable when the set is edited", () => {
    // Review Focus 1: identity must survive edits and reloads, which handles cannot.
    const arps = mk("Arps");
    const before = snapshotSong({
      tracks: [arps,
        mk("Acid V MIDI", arps, { devices: [{ name: "A" }] }),
        mk("Acid V MIDI", arps, { devices: [{ name: "B" }] }),
        mk("Bass")],
      mainTrack: mk("Main") }, "Song");
    expect(before.tracks.map((t) => t.key)).toEqual(
      ["Arps", "Arps/Acid V MIDI#1", "Arps/Acid V MIDI#2", "Bass"]);

    // Edited: unrelated track inserted earlier, a mute toggled, a device added.
    const arps2 = mk("Arps");
    const after = snapshotSong({
      tracks: [mk("Lead"), arps2,
        mk("Acid V MIDI", arps2, { devices: [{ name: "A" }] }),
        mk("Acid V MIDI", arps2, { devices: [{ name: "B" }] }),
        mk("Bass", null, { mute: true, devices: [{ name: "EQ" }] })],
      mainTrack: mk("Main") }, "Song");
    for (const t of before.tracks) {
      const same = after.byKey.get(t.key);
      expect(same, t.key).toBeDefined();
      expect(same!.name).toBe(t.name);
      expect(same!.groupPath).toEqual(t.groupPath);
      if (t.devices[0]) expect(same!.devices).toEqual(t.devices);
    }
    expect(after.byKey.get("Bass")!.muted).toBe(true);
    expect(after.byKey.get("Bass")!.devices).toEqual(["EQ"]);
  });

  it("keeps the key format unchanged when group names are unique", () => {
    // Saved mappings key on this format; it must not drift.
    const drums = mk("Drums");
    const sc = mk("Sidechained", drums);
    const s = snapshotSong({
      tracks: [drums, mk("Kick", drums), sc, mk("Cam Drums", sc), mk("Bass")],
      mainTrack: mk("Main") }, "Song");
    expect(s.tracks.map((t) => t.key)).toEqual(
      ["Drums", "Drums/Kick", "Drums/Sidechained", "Drums/Sidechained/Cam Drums", "Bass"]);
  });

  it("keeps same-named groups and their children apart", () => {
    const g1 = mk("Grp");
    const g2 = mk("Grp");
    const s = snapshotSong({
      tracks: [g1, mk("Kick", g1), g2, mk("Kick", g2)], mainTrack: mk("Main") }, "Song");
    expect(s.tracks.map((t) => t.key)).toEqual(["Grp#1", "Grp#1/Kick", "Grp#2", "Grp#2/Kick"]);
    expect(s.descendantsOf("Grp#1").map((t) => t.key)).toEqual(["Grp#1/Kick"]);
    expect(s.descendantsOf("Grp#2").map((t) => t.key)).toEqual(["Grp#2/Kick"]);
  });

  it("throws when two tracks resolve to the same key", () => {
    // A literal "Bass#1" next to two "Bass" tracks collides with the first ordinal.
    expect(() =>
      snapshotSong({ tracks: [mk("Bass"), mk("Bass"), mk("Bass#1")], mainTrack: mk("Main") }, "Song"),
    ).toThrow(/Bass#1/);
  });

  it("audible excludes groups and author-muted tracks", () => {
    const drums = mk("Drums");
    const s = snapshotSong(
      { tracks: [drums, mk("Kick", drums), mk("Snare", drums, { mute: true }), mk("Bass")],
        mainTrack: mk("Main") }, "Song");
    expect(s.tracks.filter(t => t.audible).map(t => t.name)).toEqual(["Kick", "Bass"]);
  });

  it("children of a muted group are not audible", () => {
    const drums = mk("Drums", null, { mute: true });
    const sc = mk("Sub", drums);
    const s = snapshotSong(
      { tracks: [drums, mk("Kick", drums), sc, mk("Deep", sc), mk("Bass")],
        mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Drums/Kick")!.muted).toBe(false);
    expect(s.tracks.filter((t) => t.audible).map((t) => t.name)).toEqual(["Bass"]);
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

  it("does not treat a group whose name prefixes a sibling's as its parent", () => {
    // "Drums" is a string prefix of "Drums B"; a joined-string startsWith would
    // make B's children look like Drums' children.
    const a = mk("Drums");
    const b = mk("Drums B");
    const s = snapshotSong(
      { tracks: [a, mk("Kick", a), b, mk("Shaker", b)], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums").map((t) => t.name)).toEqual(["Kick"]);
  });

  it("keeps Drums A and Drums B subtrees separate", () => {
    const a = mk("Drums A");
    const b = mk("Drums B");
    const s = snapshotSong(
      { tracks: [a, mk("Kick", a), b, mk("Shaker", b)], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums A").map((t) => t.name)).toEqual(["Kick"]);
    expect(s.descendantsOf("Drums B").map((t) => t.name)).toEqual(["Shaker"]);
  });

  it("exports the pre-mixer tap set", () => {
    expect([...PRE_MIXER_TAPS].sort()).toEqual(["Post FX", "Pre FX"]);
  });
});
