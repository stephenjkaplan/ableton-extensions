export type TapPoint = "Pre FX" | "Post FX" | "Post Mixer";
export const PRE_MIXER_TAPS: ReadonlySet<TapPoint> = new Set<TapPoint>(["Pre FX", "Post FX"]);

export interface TrackLike {
  name: string;
  mute: boolean;
  groupTrack: TrackLike | null;
  devices: readonly { name: string }[];
}
/**
 * The main track. `enabled` is the device's real on/off state; the SDK reads it
 * asynchronously (`Device On` -> `getValue()`), so the caller resolves it first
 * (see `snapshotFromContext` in live.ts). Omitted means unknown, treated as enabled:
 * the conservative reading for a check that blocks on live master devices.
 */
export interface MainTrackLike extends Omit<TrackLike, "devices"> {
  devices: readonly { name: string; enabled?: boolean }[];
}
export interface SongLike {
  tracks: readonly TrackLike[];
  mainTrack: MainTrackLike;
}

export interface TrackSnapshot {
  key: string;
  name: string;
  groupPath: readonly string[];
  isGroup: boolean;
  /** The track's own mute flag, as set on the track. See `effectiveMuted` for what is actually silenced. */
  muted: boolean;
  /**
   * Silenced by its own mute OR by any ancestor group's mute (a muted group silences its children).
   * Computed once here: every consumer (audible, validation, the mapping UI) uses this and none re-derive it.
   */
  effectiveMuted: boolean;
  devices: readonly string[];
  audible: boolean;
}

export interface SongSnapshot {
  song: string;
  tracks: readonly TrackSnapshot[];
  masterDevices: readonly { name: string; enabled: boolean }[];
  byKey: ReadonlyMap<string, TrackSnapshot>;
  descendantsOf(key: string): readonly TrackSnapshot[];
}

function pathOf(track: TrackLike): string[] {
  const out: string[] = [];
  for (let g = track.groupTrack; g; g = g.groupTrack) out.unshift(g.name);
  return out;
}

function hasMutedAncestor(track: TrackLike): boolean {
  for (let g = track.groupTrack; g; g = g.groupTrack) if (g.mute) return true;
  return false;
}

export function snapshotSong(song: SongLike, songName: string): SongSnapshot {
  const groups = new Set<TrackLike>();
  for (const t of song.tracks) if (t.groupTrack) groups.add(t.groupTrack);
  // Groups are identified by OBJECT identity (a child's groupTrack is the group's own entry in
  // song.tracks). If the SDK hands out a fresh wrapper per access, no group would be recognised:
  // groups would count as audible tracks and every pass would mute a parent of its own members.
  if (groups.size > 0 && !song.tracks.some((t) => groups.has(t))) {
    throw new Error(
      "This SDK build does not return stable group objects; stem export cannot identify groups.");
  }

  // Siblings are tracks with the same parent OBJECT and the same name. Counting
  // per parent object (not per joined path) keeps same-named groups apart.
  const siblingCounts = new Map<TrackLike | null, Map<string, number>>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const t of song.tracks) {
    let m = siblingCounts.get(t.groupTrack);
    if (!m) siblingCounts.set(t.groupTrack, (m = new Map()));
    bump(m, t.name);
  }

  // Local segment: the name, plus "#n" (1-based, track order) only for genuine
  // same-parent duplicates.
  const seen = new Map<TrackLike | null, Map<string, number>>();
  const localName = new Map<TrackLike, string>();
  for (const t of song.tracks) {
    let local = t.name;
    if ((siblingCounts.get(t.groupTrack)?.get(t.name) ?? 0) > 1) {
      let m = seen.get(t.groupTrack);
      if (!m) seen.set(t.groupTrack, (m = new Map()));
      bump(m, t.name);
      local = `${t.name}#${m.get(t.name)}`;
    }
    localName.set(t, local);
  }

  // A track's key is its parent's RESOLVED key plus its own local segment, so
  // children of same-named groups get distinct keys. Unchanged format when
  // group names are unique.
  const keyCache = new Map<TrackLike, string>();
  const keyOf = (t: TrackLike): string => {
    let k = keyCache.get(t);
    if (k === undefined) {
      const local = localName.get(t) ?? t.name;
      k = t.groupTrack ? `${keyOf(t.groupTrack)}/${local}` : local;
      keyCache.set(t, k);
    }
    return k;
  };
  const ancestorKeys = (t: TrackLike): string[] => {
    const out: string[] = [];
    for (let g = t.groupTrack; g; g = g.groupTrack) out.unshift(keyOf(g));
    return out;
  };

  const ancestorsByKey = new Map<string, string[]>();
  const tracks: TrackSnapshot[] = song.tracks.map((t) => {
    const key = keyOf(t);
    if (ancestorsByKey.has(key)) throw new Error(`Duplicate track key: "${key}"`);
    ancestorsByKey.set(key, ancestorKeys(t));
    const isGroup = groups.has(t);
    const effectiveMuted = t.mute || hasMutedAncestor(t);
    return {
      key,
      name: t.name,
      groupPath: pathOf(t),
      isGroup,
      muted: t.mute,
      effectiveMuted,
      devices: t.devices.map((d) => d.name),
      audible: !isGroup && !effectiveMuted,
    };
  });

  const byKey = new Map(tracks.map((t) => [t.key, t]));

  return {
    song: songName,
    tracks,
    byKey,
    masterDevices: song.mainTrack.devices.map((d) => ({ name: d.name, enabled: d.enabled ?? true })),
    descendantsOf(key) {
      if (!byKey.has(key)) return [];
      // Match on ancestor KEYS (segment-wise identity), never on a joined-string
      // prefix, so "Drums" is not the parent of "Drums B"'s children.
      return tracks.filter((t) => ancestorsByKey.get(t.key)!.includes(key));
    },
  };
}

/**
 * The plain-data form of a snapshot: JSON-safe, so the host can hand it to the dialog page, which
 * rebuilds a working `SongSnapshot` with `snapshotFromData`. `byKey` and `descendantsOf` are derived
 * from `tracks`, so they are not carried.
 */
export interface SnapshotData {
  song: string;
  tracks: TrackSnapshot[];
  masterDevices: { name: string; enabled: boolean }[];
}

export function snapshotToData(s: SongSnapshot): SnapshotData {
  return {
    song: s.song,
    tracks: s.tracks.map((t) => ({ ...t, groupPath: [...t.groupPath], devices: [...t.devices] })),
    masterDevices: s.masterDevices.map((d) => ({ ...d })),
  };
}

/**
 * Rebuilds a snapshot from its data form without live track objects. `descendantsOf` must match what
 * `snapshotSong` builds: ancestry by KEY, so same-named sibling groups (`Grp#1/Kick`, `Grp#2/Kick`)
 * stay apart. A group G is an ancestor of track T when both hold:
 *   - T.key starts with `G.key + "/"` (tells `Grp#1` from `Grp#2`, which share a name), and
 *   - T.groupPath starts with `[...G.groupPath, G.name]` (tells a group "Drums" from a top-level track
 *     whose name is literally "Drums/Kick", which the key prefix alone would confuse).
 */
export function snapshotFromData(d: SnapshotData): SongSnapshot {
  const tracks: TrackSnapshot[] = d.tracks.map((t) => ({ ...t, groupPath: [...t.groupPath], devices: [...t.devices] }));
  const byKey = new Map(tracks.map((t) => [t.key, t]));

  const isAncestor = (g: TrackSnapshot, t: TrackSnapshot): boolean => {
    if (!g.isGroup || !t.key.startsWith(g.key + "/")) return false;
    const gPath = [...g.groupPath, g.name];
    return gPath.length <= t.groupPath.length && gPath.every((n, i) => t.groupPath[i] === n);
  };
  const descendants = new Map<string, TrackSnapshot[]>();
  for (const g of tracks) {
    if (g.isGroup) descendants.set(g.key, tracks.filter((t) => t !== g && isAncestor(g, t)));
  }

  return {
    song: d.song,
    tracks,
    byKey,
    masterDevices: d.masterDevices.map((m) => ({ ...m })),
    descendantsOf(key) {
      return descendants.get(key) ?? [];
    },
  };
}
