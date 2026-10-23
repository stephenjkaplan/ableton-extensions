import { describe, expect, it } from "vitest";
import { enabledRealtimeDevices, matchTracks } from "../src/live.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";

const mk = (name: string, g: TrackLike | null = null): TrackLike =>
  ({ name, mute: false, groupTrack: g, devices: [] });
const main = { name: "Main", mute: false, groupTrack: null, devices: [] };

describe("matchTracks", () => {
  it("maps every snapshot key onto the live track, using snapshot.ts's own key rule", () => {
    const arps = mk("Arps");
    const a1 = mk("Acid V MIDI", arps), a2 = mk("Acid V MIDI", arps);
    const bass = mk("Bass");
    const tracks = [arps, a1, a2, bass];
    const snap = snapshotSong({ tracks, mainTrack: main }, "Song");
    const m = matchTracks(tracks, snap);
    expect(m.get("Arps")).toBe(arps);
    expect(m.get("Arps/Acid V MIDI#1")).toBe(a1);
    expect(m.get("Arps/Acid V MIDI#2")).toBe(a2);
    expect(m.get("Bass")).toBe(bass);
    expect([...m.keys()]).toEqual(snap.tracks.map((t) => t.key));
  });

  it("throws when a track was added, removed or renamed since the snapshot", () => {
    const tracks = [mk("Kick"), mk("Bass")];
    const snap = snapshotSong({ tracks, mainTrack: main }, "Song");
    expect(() => matchTracks([...tracks, mk("New")], snap)).toThrow(/changed since/);
    expect(() => matchTracks([tracks[0]], snap)).toThrow(/changed since/);
    expect(() => matchTracks([tracks[0], mk("Bass 2")], snap)).toThrow(/changed since/);
  });

  it("throws when only the order changed (ordinals would point at the wrong track)", () => {
    const a = mk("X"), b = mk("X");
    const snap = snapshotSong({ tracks: [a, b], mainTrack: main }, "Song");
    // same keys, different tracks, order preserved -> still maps by position
    expect(matchTracks([a, b], snap).get("X#2")).toBe(b);
    expect(() => matchTracks([mk("Y"), a, b], snap)).toThrow(/changed since/);
  });
});

describe("enabledRealtimeDevices", () => {
  type Dev = Parameters<typeof enabledRealtimeDevices>[0][number];
  const dev = (name: string, on = true, chains: Dev[][] = []): Dev => ({
    name,
    parameters: [{ name: "Device On", getValue: async () => (on ? 1 : 0) }],
    ...(chains.length ? { chains: chains.map((devices) => ({ devices })) } : {}),
  });

  it("finds enabled External Instrument and External Audio Effect devices, and nothing else", async () => {
    expect(await enabledRealtimeDevices([
      dev("Serum 2"), dev("External Instrument"), dev("EQ Eight"), dev("External Audio Effect"),
    ])).toEqual(["External Instrument", "External Audio Effect"]);
  });

  it("skips a switched-off External device", async () => {
    expect(await enabledRealtimeDevices([dev("External Instrument", false)])).toEqual([]);
  });

  it("looks inside rack chains, but not inside a switched-off rack", async () => {
    const inner = [dev("External Instrument")];
    expect(await enabledRealtimeDevices([dev("Instrument Rack", true, [[dev("Utility")], inner])]))
      .toEqual(["External Instrument"]);
    expect(await enabledRealtimeDevices([dev("Instrument Rack", false, [inner])])).toEqual([]);
  });

  it("reads Device On only for External devices and racks", async () => {
    let reads = 0;
    const spy = (name: string): Dev => ({ name, parameters: [{ name: "Device On", getValue: async () => (reads++, 1) }] });
    await enabledRealtimeDevices([spy("Serum 2"), spy("EQ Eight"), spy("External Instrument")]);
    expect(reads).toBe(1);
  });

  it("treats a device with no Device On parameter as on", async () => {
    expect(await enabledRealtimeDevices([{ name: "External Instrument", parameters: [] }]))
      .toEqual(["External Instrument"]);
  });
});
