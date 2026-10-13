import { emptyManifest, type Manifest } from "../src/manifest-core.js";
import type { SnapshotData, TrackSnapshot } from "../src/snapshot.js";
import type { MappingRequest } from "../src/ui/protocol.js";

/** A readable track row for building test requests; `buildRequest` turns the list into the request's snapshot. */
export type PageTrack = { key: string; name: string; depth: number; isGroup: boolean; muted: boolean; devices: string[] };

/**
 * The snapshot, base manifest, taps and notes a hand-built request must carry now that the page validates
 * for itself. Derived from the same `tracks` the request lists, so the two cannot disagree. `groupPath` comes
 * from `depth` (tracks are in tree order), and `key`s are used as given.
 */
export function liveFields(
  tracks: PageTrack[], song = "Song", masterDevices: SnapshotData["masterDevices"] = [],
): Pick<MappingRequest, "snapshot" | "base" | "taps" | "notes"> {
  const path: string[] = [];
  const snapTracks: TrackSnapshot[] = tracks.map((t) => {
    // A row deeper than the groups listed before it (a fixture shortcut) gets placeholder ancestors.
    while (path.length < t.depth) path.push(`group ${path.length + 1}`);
    path.length = t.depth;
    const groupPath = [...path];
    if (t.isGroup) path.push(t.name);
    return {
      key: t.key, name: t.name, groupPath, isGroup: t.isGroup,
      muted: t.muted, effectiveMuted: t.muted, devices: [...t.devices],
      audible: !t.isGroup && !t.muted,
    };
  });
  const base: Manifest = emptyManifest(song);
  return { snapshot: { song, tracks: snapTracks, masterDevices }, base, taps: [], notes: [] };
}

/** A request from the fields the dialog tests care about; `tracks` becomes `snapshot.tracks` (the request has no other copy). */
export function buildRequest(
  r: Omit<MappingRequest, "snapshot" | "base" | "taps" | "notes"> & { tracks: PageTrack[] } & Partial<Pick<MappingRequest, "notes" | "taps">>,
): MappingRequest {
  const { tracks, ...rest } = r;
  return { ...liveFields(tracks, r.song), ...rest };
}
