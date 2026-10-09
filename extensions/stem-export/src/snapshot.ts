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

export function snapshotSong(song: SongLike, songName: string): SongSnapshot {
  const groups = new Set<TrackLike>();
  for (const t of song.tracks) if (t.groupTrack) groups.add(t.groupTrack);

  // Count same-name siblings so only genuine duplicates get an ordinal.
  const siblingCounts = new Map<string, number>();
  const prefixOf = (t: TrackLike) => [...pathOf(t), t.name].join("/");
  for (const t of song.tracks) {
    const p = prefixOf(t);
    siblingCounts.set(p, (siblingCounts.get(p) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const tracks: TrackSnapshot[] = song.tracks.map((t) => {
    const prefix = prefixOf(t);
    const isGroup = groups.has(t);
    let key = prefix;
    if ((siblingCounts.get(prefix) ?? 0) > 1) {
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      key = `${prefix}#${n}`;
    }
    return {
      key,
      name: t.name,
      groupPath: pathOf(t),
      isGroup,
      muted: t.mute,
      devices: t.devices.map((d) => d.name),
      audible: !isGroup && !t.mute,
    };
  });

  const byKey = new Map(tracks.map((t) => [t.key, t]));

  return {
    song: songName,
    tracks,
    byKey,
    masterDevices: song.mainTrack.devices.map((d) => ({ name: d.name, enabled: true })),
    descendantsOf(key) {
      const root = byKey.get(key);
      if (!root) return [];
      // Compare path SEGMENTS, not a joined string: a prefix match would make
      // "Drums A" a parent of "Drums B".
      const prefix = [...root.groupPath, root.name];
      const isUnder = (path: readonly string[]) =>
        path.length >= prefix.length && prefix.every((seg, i) => path[i] === seg);
      return tracks.filter((t) => t !== root && isUnder(t.groupPath));
    },
  };
}
