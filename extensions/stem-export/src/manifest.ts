import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function manifestPath(storageDir: string, song: string): string {
  return join(storageDir, "manifests", `${safeName(song)}.json`);
}

export function saveManifest(m: Manifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(m, null, 2), "utf8");
  renameSync(tmpPath, path);
}

export function loadManifest(path: string): Manifest | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null || typeof data.song !== "string" || typeof data.stems !== "object" || data.stems === null) {
      throw new Error(`Invalid manifest format in ${path}: missing or invalid song/stems`);
    }
    return data as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function resolve(m: Manifest, s: SongSnapshot): Resolution {
  const assigned = new Map<string, string>();
  const unresolved: string[] = [];
  const doubleClaimed: string[] = [];

  for (const [stem, spec] of Object.entries(m.stems)) {
    // Backing is always computed, regardless of the flag
    if (spec.computed || stem === BACKING) {
      if (stem === BACKING && spec.trackKeys.length > 0) {
        unresolved.push(...spec.trackKeys);
      }
      continue;
    }
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
  };
}
