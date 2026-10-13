// The pure half of the manifest <-> dialog mapping: no I/O, so it can be bundled into the dialog page.
import { DEFAULT_REGISTRY } from "./default-registry.js";
import { BACKING, resolve, type Manifest, type StemSpec } from "./manifest-core.js";
import type { SongSnapshot } from "./snapshot.js";
import type { MappingResponse } from "./ui/protocol.js";
import { validate, type KeyTap } from "./validate.js";

/** The dialog's starting point: which stem each track is assigned to in the saved manifest. */
export function assignmentsOf(m: Manifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [stem, spec] of Object.entries(m.stems)) {
    if (stem === BACKING || spec.computed) continue;
    for (const k of spec.trackKeys) out[k] = stem;
  }
  return out;
}

/** The dialog's reply as a manifest. Backing stays computed; targets and stem suffixes carry over. */
export function manifestFromResponse(base: Manifest, resp: MappingResponse, song: string): Manifest {
  const stems: Record<string, StemSpec> = {};
  for (const [key, stem] of Object.entries(resp.assignments)) {
    if (stem === BACKING) continue;
    const spec = (stems[stem] ??= { trackKeys: [] });
    spec.trackKeys.push(key);
    const suffix = base.stems[stem]?.suffix;
    if (suffix) spec.suffix = suffix;
  }
  stems[BACKING] = { trackKeys: [], computed: true };
  return { ...base, song, stems, extras: resp.extras.map((e) => ({ name: e.name, trackKeys: [...e.trackKeys] })) };
}

/** Validates `m` against the Set as it is NOW. The host never trusts the dialog's own findings. */
export function check(snap: SongSnapshot, m: Manifest, taps: readonly KeyTap[]) {
  const resolution = resolve(m, snap);
  return { resolution, findings: validate(snap, m, resolution, DEFAULT_REGISTRY, taps) };
}

/**
 * Drops from every stem and extra each track key that no longer names a real track: absent from the
 * Set, or now a group. A key that exists but is muted is a held-out track, not stale, and stays.
 * `dropped` lists each removed key once, in first-seen order. `base` is not mutated.
 */
export function pruneStale(base: Manifest, snap: SongSnapshot): { manifest: Manifest; dropped: string[] } {
  const dropped = new Set<string>();
  const live = (k: string): boolean => {
    const t = snap.byKey.get(k);
    if (t !== undefined && !t.isGroup) return true;
    dropped.add(k);
    return false;
  };
  const stems: Record<string, StemSpec> = {};
  for (const [name, spec] of Object.entries(base.stems)) {
    stems[name] = { ...spec, trackKeys: spec.trackKeys.filter(live) };
  }
  const extras = base.extras.map((e) => ({ ...e, trackKeys: e.trackKeys.filter(live) }));
  return { manifest: { ...base, stems, extras }, dropped: [...dropped] };
}

/** Every distinct track key a manifest names, across all its stems and extras. */
export function namedKeys(m: Manifest): Set<string> {
  const keys = new Set<string>();
  for (const spec of Object.values(m.stems)) for (const k of spec.trackKeys) keys.add(k);
  for (const e of m.extras) for (const k of e.trackKeys) keys.add(k);
  return keys;
}

/** A saved mapping is only recognised as this Set's when at least this many of its tracks are in the Set... */
export const MATCH_MIN_TRACKS = 2;
/** ...and at least this share of the tracks it names are. */
export const MATCH_MIN_SHARE = 0.6;

/**
 * Which saved mapping, if any, belongs to the open Set. Live gives extensions no Set name or path, so
 * the only evidence is the tracks: for each saved manifest, `total` is the distinct track keys it names
 * across every stem and extra, and `matched` is how many of those are in the Set and are not groups (a
 * muted track still counts: it is the same Set). A manifest is eligible with at least two matches AND at
 * least 60 percent of its tracks; the eligible one with the most matches wins, the newer file on a tie.
 * Neither argument is mutated.
 */
export function matchManifests(
  saved: readonly { name: string; manifest: Manifest; mtimeMs: number }[], snap: SongSnapshot,
): { name: string; manifest: Manifest; matched: number; total: number } | null {
  let best: { name: string; manifest: Manifest; matched: number; total: number; mtimeMs: number } | null = null;
  for (const s of saved) {
    const keys = namedKeys(s.manifest);
    let matched = 0;
    for (const k of keys) {
      const t = snap.byKey.get(k);
      if (t !== undefined && !t.isGroup) matched++;
    }
    const total = keys.size;
    if (matched < MATCH_MIN_TRACKS || matched / total < MATCH_MIN_SHARE) continue;
    if (best === null || matched > best.matched || (matched === best.matched && s.mtimeMs > best.mtimeMs)) {
      best = { name: s.name, manifest: s.manifest, matched, total, mtimeMs: s.mtimeMs };
    }
  }
  return best && { name: best.name, manifest: best.manifest, matched: best.matched, total: best.total };
}
