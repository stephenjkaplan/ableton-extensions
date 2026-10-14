import type { SongSnapshot } from "./snapshot.js";

/** The computed-remainder stem. Never claimed by the user. */
export const BACKING = "Backing";

export interface StemSpec { trackKeys: string[]; suffix?: string; computed?: boolean }
export interface ExtraSpec { name: string; trackKeys: string[] }

export interface Manifest {
  song: string;
  targetLufs: number;
  truePeakCeilingDb: number;
  appliedGainDb: number | null;
  stems: Record<string, StemSpec>;
  extras: ExtraSpec[];
}

export interface Resolution {
  assigned: ReadonlyMap<string, string>;
  backing: readonly string[];
  unresolved: readonly string[];
  doubleClaimed: readonly string[];
  /**
   * Stems (other than Backing) that the manifest names but whose tracks are ALL muted, so none is
   * audible. Treated as absent, not empty: left out of the plan and of the empty-stem check, while
   * the assignment stays in the manifest for when a track is unmuted. A stem with no tracks at all,
   * or with a track that is missing or a group, is not absent (those are real mistakes).
   */
  absent: readonly string[];
}

export function emptyManifest(song: string): Manifest {
  return {
    song,
    targetLufs: -18,
    truePeakCeilingDb: -6,
    appliedGainDb: null,
    stems: { Backing: { trackKeys: [], computed: true } },
    extras: [],
  };
}

export function safeName(name: string): string {
  const sanitized = name.replace(/[/\\\0]/g, "_").trim();
  return /^\.+$/.test(sanitized) ? "untitled" : sanitized || "untitled";
}

export function resolve(m: Manifest, s: SongSnapshot): Resolution {
  const assigned = new Map<string, string>();
  const unresolved: string[] = [];
  const doubleClaimed: string[] = [];
  const absent: string[] = [];

  for (const [stem, spec] of Object.entries(m.stems)) {
    // Backing is always computed, regardless of the flag
    if (spec.computed || stem === BACKING) {
      if (stem === BACKING && spec.trackKeys.length > 0) {
        unresolved.push(...spec.trackKeys);
      }
      continue;
    }
    if (spec.trackKeys.length > 0 && spec.trackKeys.every((k) => {
      const t = s.byKey.get(k);
      return t !== undefined && !t.isGroup && !t.audible;
    })) absent.push(stem);
    for (const key of spec.trackKeys) {
      const track = s.byKey.get(key);
      if (!track || !track.audible) {
        if (!track || track.isGroup) unresolved.push(key);
        continue;
      }
      if (assigned.has(key) && assigned.get(key) !== stem) doubleClaimed.push(key);
      else assigned.set(key, stem);
    }
  }

  const backing = s.tracks
    .filter((t) => t.audible && !assigned.has(t.key))
    .map((t) => t.key);

  return {
    assigned,
    backing,
    unresolved: [...new Set(unresolved)],
    doubleClaimed: [...new Set(doubleClaimed)],
    absent,
  };
}
