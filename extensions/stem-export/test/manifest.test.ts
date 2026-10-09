import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const m = withStems({
      "Arturia - Played": { trackKeys: ["Womp"], suffix: " Jup Sync Lead" },
      Backing: { trackKeys: [], computed: true },
    });
    const p = manifestPath(dir, "Song");
    saveManifest(m, p);
    const back = loadManifest(p)!;
    expect(back.stems["Arturia - Played"].suffix).toBe(" Jup Sync Lead");
    expect(back.stems.Backing.computed).toBe(true);
    expect(back.targetLufs).toBe(-18);
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
});
