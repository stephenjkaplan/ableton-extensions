// What each Session clip is: its own track, a layer on another clip, or left alone.
import type { ClipKey, LiveScan, SessionClip } from "./types.js";

export type Role = { kind: "track" } | { kind: "layer"; host: ClipKey | null } | { kind: "leave" };

const TIE_BEATS = 1;

/**
 * The owner works DJ sets out in Arrangement first, so what a layer overlaps there says what it sits on.
 * Null when there's a tie, nothing to go on, or the best file has more than one non-layer Session clip.
 */
export function suggestHost(clip: SessionClip, scan: LiveScan, layerTracks: number[]): ClipKey | null {
  const hostsByFile = new Map<string, SessionClip[]>();
  for (const c of scan.session) {
    if (layerTracks.includes(c.trackIndex) || c.filePath === clip.filePath) continue;
    hostsByFile.set(c.filePath, [...(hostsByFile.get(c.filePath) ?? []), c]);
  }

  const overlap = new Map<string, number>();
  const placements = scan.arrangement.filter((a) => a.filePath === clip.filePath);
  for (const other of scan.arrangement) {
    if (!hostsByFile.has(other.filePath)) continue;
    for (const p of placements) {
      const shared = Math.min(p.end, other.end) - Math.max(p.start, other.start);
      if (shared > 0) overlap.set(other.filePath, (overlap.get(other.filePath) ?? 0) + shared);
    }
  }

  const ranked = [...overlap.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < TIE_BEATS) return null;
  const hosts = hostsByFile.get(ranked[0][0])!;
  return hosts.length === 1 ? hosts[0].key : null;
}

/** Answers beat starting roles. A layer whose host isn't currently a track goes back to needing an answer. */
export function resolveRoles(scan: LiveScan, layerTracks: number[], answers: Record<ClipKey, Role>): Map<ClipKey, Role> {
  const roles = new Map<ClipKey, Role>();
  for (const clip of scan.session) {
    const start: Role = layerTracks.includes(clip.trackIndex)
      ? { kind: "layer", host: suggestHost(clip, scan, layerTracks) }
      : { kind: "track" };
    roles.set(clip.key, answers[clip.key] ?? start);
  }
  for (const [key, role] of roles) {
    if (role.kind === "layer" && role.host !== null && roles.get(role.host)?.kind !== "track") {
      roles.set(key, { kind: "layer", host: null });
    }
  }
  return roles;
}
