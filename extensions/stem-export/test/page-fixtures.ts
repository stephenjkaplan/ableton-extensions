import { emptyManifest, type Manifest } from "../src/manifest-core.js";
import { snapshotSong, snapshotToData, type SnapshotData, type TrackLike, type TrackSnapshot } from "../src/snapshot.js";
import type { MappingRequest } from "../src/ui/protocol.js";

/** A readable track row for building test requests; `buildRequest` turns the list into the request's snapshot. */
export type PageTrack = { key: string; name: string; depth: number; isGroup: boolean; muted: boolean; devices: string[] };

/**
 * The snapshot, base manifest, taps and notes a hand-built request must carry now that the page validates
 * for itself. The snapshot is built by the REAL `snapshotSong` from the track list, so `groupPath`,
 * `effectiveMuted` (own mute OR any ancestor group's mute) and `audible` are exactly what production derives and
 * cannot be faked to agree. `muted` on a row is the track's OWN mute flag. Rows are in tree order; a row's `depth`
 * must be at most one more than the group row it sits under, and a row marked `isGroup` needs a child. Only the
 * `key`s are the fixture's own (so tests can use hostile or short keys).
 */
export function liveFields(
  tracks: PageTrack[], song = "Song", masterDevices: SnapshotData["masterDevices"] = [],
): Pick<MappingRequest, "snapshot" | "base" | "taps" | "notes"> {
  const stack: TrackLike[] = [];
  const live: TrackLike[] = tracks.map((t) => {
    if (t.depth > stack.length) throw new Error(`fixture row "${t.key}" is deeper than any group above it`);
    stack.length = t.depth;
    const row: TrackLike = {
      name: t.name, mute: t.muted, groupTrack: stack[t.depth - 1] ?? null, devices: t.devices.map((name) => ({ name })),
    };
    if (t.isGroup) stack.push(row);
    return row;
  });
  const real = snapshotSong({
    tracks: live,
    mainTrack: { name: "Main", mute: false, groupTrack: null, devices: masterDevices.map((d) => ({ ...d })) },
  }, song);
  const snapTracks: TrackSnapshot[] = real.tracks.map((t, i) => {
    if (t.isGroup !== tracks[i].isGroup) throw new Error(`fixture row "${tracks[i].key}": isGroup disagrees with its children`);
    return { ...t, key: tracks[i].key };
  });
  const base: Manifest = emptyManifest(song);
  return { snapshot: snapshotToData({ ...real, tracks: snapTracks }), base, taps: [], notes: [] };
}

/** A request from the fields the dialog tests care about; `tracks` becomes `snapshot.tracks` (the request has no other copy). */
export function buildRequest(
  r: Omit<MappingRequest, "snapshot" | "base" | "taps" | "notes"> & { tracks: PageTrack[] } & Partial<Pick<MappingRequest, "notes" | "taps">>,
): MappingRequest {
  const { tracks, ...rest } = r;
  return { ...liveFields(tracks, r.song), ...rest };
}
