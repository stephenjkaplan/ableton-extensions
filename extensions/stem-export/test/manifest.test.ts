import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import { emptyManifest, loadManifest, manifestPath, resolve, safeName, saveManifest,
         type Manifest } from "../src/manifest.js";

const mk = (name: string, group: TrackLike | null = null, mute = false): TrackLike =>
  ({ name, mute, groupTrack: group, devices: [] });

function snap() {
  const drums = mk("Drums");
  return snapshotSong(
    { tracks: [drums, mk("Kick", drums), mk("Snare", drums, true), mk("Bass")],
      mainTrack: mk("Main") }, "Song");
}

function withStems(stems: Manifest["stems"]): Manifest {
  return { ...emptyManifest("Song"), stems };
}

describe("manifest", () => {
  it("round-trips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const m: Manifest = {
      song: "Test Song",
      targetLufs: -16,
      truePeakCeilingDb: -3,
      appliedGainDb: 1.5,
      stems: {
        "Arturia - Played": { trackKeys: ["Womp"], suffix: " Jup Sync Lead" },
        Backing: { trackKeys: [], computed: true },
      },
      extras: [{ name: "Extra", trackKeys: ["x1"] }],
    };
    const p = manifestPath(dir, "Test Song");
    saveManifest(m, p);
    const back = loadManifest(p)!;
    expect(back.song).toBe("Test Song");
    expect(back.targetLufs).toBe(-16);
    expect(back.truePeakCeilingDb).toBe(-3);
    expect(back.appliedGainDb).toBe(1.5);
    expect(back.stems["Arturia - Played"].suffix).toBe(" Jup Sync Lead");
    expect(back.stems.Backing.computed).toBe(true);
    expect(back.extras[0].name).toBe("Extra");
  });

  it("returns null for an absent manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    expect(loadManifest(manifestPath(dir, "Nope"))).toBeNull();
  });

  it("computes Backing as the unclaimed remainder", () => {
    const r = resolve(withStems({ "Drums": { trackKeys: ["Drums/Kick"] } }), snap());
    expect([...r.assigned.entries()]).toEqual([["Drums/Kick", "Drums"]]);
    expect(r.backing).toEqual(["Bass"]);
  });

  it("never puts author-muted tracks in Backing", () => {
    const r = resolve(withStems({}), snap());
    expect(r.backing).not.toContain("Drums/Snare");
    expect(r.backing).toEqual(["Drums/Kick", "Bass"]);
  });

  it("reports a stale track reference instead of throwing", () => {
    // Review Focus 1: a track renamed or deleted since the mapping was saved.
    const r = resolve(withStems({ Drums: { trackKeys: ["Drums/Ghost"] } }), snap());
    expect(r.unresolved).toEqual(["Drums/Ghost"]);
    expect(r.assigned.size).toBe(0);
  });

  it("treats a stem whose tracks are all muted as absent, keeping the manifest untouched", () => {
    const m = withStems({ Drums: { trackKeys: ["Drums/Snare"] }, Bass: { trackKeys: ["Bass"] } });
    const before = JSON.stringify(m);
    const r = resolve(m, snap());
    expect(r.absent).toEqual(["Drums"]);
    expect(r.assigned.get("Bass")).toBe("Bass");
    expect(r.unresolved).toEqual([]);
    expect(JSON.stringify(m)).toBe(before);   // the assignment survives for when the track is unmuted
  });

  it("flags a track claimed by two stems", () => {
    const r = resolve(withStems({
      Drums: { trackKeys: ["Drums/Kick"] },
      "Serum - Backing": { trackKeys: ["Drums/Kick"] },
    }), snap());
    expect(r.doubleClaimed).toEqual(["Drums/Kick"]);
  });

  it("makes names safe as path components", () => {
    // Review Focus 5: a "/" must not escape the output directory.
    expect(safeName("AC/DC Tribute")).toBe("AC_DC Tribute");
    expect(safeName("../../etc")).toBe(".._.._etc");
    expect(safeName("")).toBe("untitled");
    expect(safeName("   ")).toBe("untitled");
    expect(safeName("Learning to Feel")).toBe("Learning to Feel");
    expect(safeName("..")).toBe("untitled");
    expect(safeName(".")).toBe("untitled");
  });

  it("builds a manifest path inside the storage directory", () => {
    const p = manifestPath("/tmp/store", "AC/DC Tribute");
    expect(p).toBe("/tmp/store/manifests/AC_DC Tribute.json");
  });

  it("ignores assignments pointing at group tracks", () => {
    const r = resolve(withStems({ Drums: { trackKeys: ["Drums"] } }), snap());
    expect(r.assigned.size).toBe(0);
    expect(r.unresolved).toEqual(["Drums"]);
  });

  it("treats Backing as computed by name regardless of flag", () => {
    const r = resolve(withStems({ Backing: { trackKeys: ["Drums/Kick"] } }), snap());
    expect(r.assigned.size).toBe(0);
    expect(r.unresolved).toEqual(["Drums/Kick"]);
    expect(r.backing).toEqual(["Drums/Kick", "Bass"]);
  });

  it("pushes Backing trackKeys into unresolved when computed", () => {
    const r = resolve(withStems({ Backing: { trackKeys: ["Ghost1", "Ghost2"], computed: true } }), snap());
    expect(r.assigned.size).toBe(0);
    expect(r.unresolved).toEqual(["Ghost1", "Ghost2"]);
  });

  it("rejects invalid manifest JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const p = manifestPath(dir, "Bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken json", "utf8");
    expect(() => loadManifest(p)).toThrow();
  });

  it("rejects manifest with missing song field", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const p = manifestPath(dir, "Bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ stems: {} }), "utf8");
    expect(() => loadManifest(p)).toThrow(/Invalid manifest format/);
  });

  it("rejects manifest with missing stems field", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const p = manifestPath(dir, "Bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ song: "Test" }), "utf8");
    expect(() => loadManifest(p)).toThrow(/Invalid manifest format/);
  });

  it("rejects manifest with null stems", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const p = manifestPath(dir, "Bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ song: "Test", stems: null }), "utf8");
    expect(() => loadManifest(p)).toThrow(/Invalid manifest format/);
  });

  it("rejects ENOTDIR errors", () => {
    // Try to load a manifest from a path that goes through a file, not a directory
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const filePath = join(dir, "somefile");
    writeFileSync(filePath, "content");
    const badPath = join(filePath, "manifests", "test.json");
    expect(() => loadManifest(badPath)).toThrow();
  });
});
