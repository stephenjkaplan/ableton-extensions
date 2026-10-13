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
