import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY as R } from "../src/default-registry.js";
import { emptyManifest, resolve, type Manifest } from "../src/manifest.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import { blocking, validate } from "../src/validate.js";

const mk = (name: string, g: TrackLike | null = null, mute = false,
            devices: { name: string }[] = []): TrackLike =>
  ({ name, mute, groupTrack: g, devices });

const withStems = (stems: Manifest["stems"]): Manifest => ({ ...emptyManifest("Song"), stems });
const rules = (f: ReturnType<typeof validate>, sev?: string) =>
  new Set(f.filter((x) => !sev || x.severity === sev).map((x) => x.rule));

function run(song: Parameters<typeof snapshotSong>[0], m: Manifest, taps = []) {
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

  it("flags a stem that would render silent", () => {
    const f = run({ tracks: [mk("Bass", null, true)], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "error")).toContain("empty-stem");
  });

  it("flags an unknown stem name and suggests a fix", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ "Organ - Playedl": { trackKeys: ["Bass"] } }));
    const hit = f.find((x) => x.rule === "unknown-stem")!;
    expect(hit.detail).toContain("Organ - Played");
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
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post Mixer" }] as never);
    const hit = f.find((x) => x.rule === "post-mixer-key")!;
    expect(hit.severity).toBe("error");
    expect(hit.detail).toContain("Kick");
  });

  it("does not flag pre-mixer taps", () => {
    const f = run({ tracks: [mk("Kick"), mk("Sub")], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] }, "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post FX" }] as never);
    expect(rules(f, "error")).not.toContain("post-mixer-key");
  });

  it("reports Backing fall-through and held-out mutes", () => {
    const f = run({ tracks: [mk("Kick"), mk("Bass"), mk("Old Idea", null, true)],
                    mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] } }));
    expect(f.find((x) => x.rule === "backing-fallthrough")!.detail).toContain("Bass");
    expect(f.find((x) => x.rule === "muted-held-out")!.detail).toContain("Old Idea");
  });

  it("blocking returns only errors", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main", null, false, [{ name: "X" }]) },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(blocking(f).every((x) => x.severity === "error")).toBe(true);
  });
});
