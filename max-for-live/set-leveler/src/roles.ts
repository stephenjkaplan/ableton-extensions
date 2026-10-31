// What each Session clip is: its own track, a layer on another clip, or left alone.
import type { ClipKey, LiveScan, SessionClip } from "./types.js";

export type Role = { kind: "track" } | { kind: "layer"; host: ClipKey | null } | { kind: "leave" };

const TIE_BEATS = 1;
const LAYER_COVERAGE = 0.8; // how much of a clip must sit inside one longer clip for it to count as a layer

/** Beats of each other file that a file's Arrangement placements overlap. */
function overlaps(file: string, scan: LiveScan, sessionFiles: Set<string>): Map<string, number> {
  const shared = new Map<string, number>();
  const placements = scan.arrangement.filter((a) => a.filePath === file);
  for (const other of scan.arrangement) {
    if (other.filePath === file || !sessionFiles.has(other.filePath)) continue;
    for (const p of placements) {
      const beats = Math.min(p.end, other.end) - Math.max(p.start, other.start);
      if (beats > 0) shared.set(other.filePath, (shared.get(other.filePath) ?? 0) + beats);
    }
  }
  return shared;
}

/**
 * The owner works DJ sets out in Arrangement first, so it says what plays together. A clip that sits mostly
 * inside one longer clip is a layer, whichever track it's on. Otherwise it's a track, unless it's not there at all.
 */
function startingRoles(scan: LiveScan): Map<ClipKey, Role> {
  const sessionFiles = new Set(scan.session.map((c) => c.filePath));
  const length = new Map<string, number>();
  for (const a of scan.arrangement) length.set(a.filePath, (length.get(a.filePath) ?? 0) + a.end - a.start);

  const isLayerFile = new Map<string, boolean>();
  const shared = new Map<string, Map<string, number>>();
  for (const file of sessionFiles) {
    const own = length.get(file) ?? 0;
    const overlap = overlaps(file, scan, sessionFiles);
    shared.set(file, overlap);
    isLayerFile.set(file, [...overlap].some(([other, beats]) => (length.get(other) ?? 0) > own && beats / own >= LAYER_COVERAGE));
  }

  const clipsOf = (file: string) => scan.session.filter((c) => c.filePath === file);
  const host = (clip: SessionClip): ClipKey | null => {
    const ranked = [...shared.get(clip.filePath)!].filter(([f]) => !isLayerFile.get(f)).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) return null;
    if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < TIE_BEATS) return null;
    const clips = clipsOf(ranked[0][0]);
    return clips.length === 1 ? clips[0].key : null;
  };

  const roles = new Map<ClipKey, Role>();
  for (const clip of scan.session) {
    if (!length.has(clip.filePath)) roles.set(clip.key, { kind: "layer", host: null });
    else if (isLayerFile.get(clip.filePath)) roles.set(clip.key, { kind: "layer", host: host(clip) });
    else roles.set(clip.key, { kind: "track" });
  }
  return roles;
}

/** Answers beat starting roles. A layer whose host isn't currently a track goes back to needing an answer. */
export function resolveRoles(scan: LiveScan, answers: Record<ClipKey, Role>): Map<ClipKey, Role> {
  const roles = startingRoles(scan);
  for (const clip of scan.session) {
    const answer = answers[clip.key];
    if (answer) roles.set(clip.key, answer);
  }
  for (const [key, role] of roles) {
    if (role.kind === "layer" && role.host !== null && roles.get(role.host)?.kind !== "track") {
      roles.set(key, { kind: "layer", host: null });
    }
  }
  return roles;
}
