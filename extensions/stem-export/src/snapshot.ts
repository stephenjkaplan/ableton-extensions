export type TapPoint = "Pre FX" | "Post FX" | "Post Mixer";
export const PRE_MIXER_TAPS: ReadonlySet<TapPoint> = new Set<TapPoint>(["Pre FX", "Post FX"]);

export interface TrackLike {
  name: string;
  mute: boolean;
  groupTrack: TrackLike | null;
  devices: readonly { name: string }[];
}
export interface SongLike {
  tracks: readonly TrackLike[];
  mainTrack: TrackLike;
}

export interface TrackSnapshot {
  key: string;
  name: string;
  groupPath: readonly string[];
  isGroup: boolean;
  muted: boolean;
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
    return {
      key,
      name: t.name,
      groupPath: pathOf(t),
      isGroup,
      muted: t.mute,
      devices: t.devices.map((d) => d.name),
      // Muting a group silences its children, so an ancestor mute counts too.
      audible: !isGroup && !t.mute && !hasMutedAncestor(t),
    };
  });

  const byKey = new Map(tracks.map((t) => [t.key, t]));

  return {
    song: songName,
    tracks,
    byKey,
    masterDevices: song.mainTrack.devices.map((d) => ({ name: d.name, enabled: true })),
    descendantsOf(key) {
      if (!byKey.has(key)) return [];
      // Match on ancestor KEYS (segment-wise identity), never on a joined-string
      // prefix, so "Drums" is not the parent of "Drums B"'s children.
      return tracks.filter((t) => ancestorsByKey.get(t.key)!.includes(key));
    },
  };
}
