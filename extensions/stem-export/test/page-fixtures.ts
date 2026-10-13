import { emptyManifest, type Manifest } from "../src/manifest-core.js";
import type { SnapshotData, TrackSnapshot } from "../src/snapshot.js";
import type { MappingRequest } from "../src/ui/protocol.js";

type PageTrack = MappingRequest["tracks"][number];

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

/** A request from the fields the dialog tests care about; the validator inputs are derived from `tracks`. */
export function buildRequest(
  r: Omit<MappingRequest, "snapshot" | "base" | "taps" | "notes"> & Partial<Pick<MappingRequest, "notes" | "taps">>,
): MappingRequest {
  return { ...liveFields(r.tracks, r.song), ...r };
}
