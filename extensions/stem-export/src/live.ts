// The ONLY module that touches the Live SDK. Everything else takes the LiveBridge interfaces.
// Kept thin on purpose: the logic worth testing lives in run.ts and snapshot.ts.
import type { Device, ExtensionContext, Track } from "@ableton-extensions/sdk";
import type { Host } from "./commands.js";
import { messageUrl, type MessageSpec } from "./ui/message.js";
import { ordinalKeys, type LiveBridge, type LiveMasterDevice, type LiveTrack } from "./run.js";
import { REALTIME_DEVICE_NAMES, snapshotSong, type RealtimeDevice, type SongSnapshot, type TrackLike } from "./snapshot.js";

type Ctx = ExtensionContext<"1.0.0">;
type LiveDevice = Device<"1.0.0">;

const DEVICE_ON = "Device On";

function deviceOn(d: LiveDevice) {
  const p = d.parameters.find((x) => x.name === DEVICE_ON);
  if (!p) throw new Error(`Master device "${d.name}" has no "${DEVICE_ON}" parameter; cannot bypass it.`);
  return p;
}

/**
 * Sidechain tap points are NOT reachable: the SDK exposes no routing or sidechain accessor
 * (see docs/superpowers/notes/sidechain-taps.md). Always empty until it does. Callers must
 * not read an empty list as "no Post Mixer taps".
 */
export function bridgeTaps(): [] {
  return [];
}

/** The slice of the SDK's Device the scan reads. A rack is recognised by its `chains`. */
interface ScannedDevice {
  name: string;
  parameters: readonly { name: string; getValue(): Promise<number> }[];
  chains?: readonly { devices: readonly ScannedDevice[] }[];
}

/**
 * Names of the switched-on External devices in a chain, looking inside racks. A switched-off device (or
 * rack) is skipped with everything in it. No Device On parameter is read as on: a false warning is cheap.
 */
export async function enabledRealtimeDevices(devices: readonly ScannedDevice[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of devices) {
    const external = REALTIME_DEVICE_NAMES.has(d.name);
    const chains = d.chains ?? [];
    if (!external && chains.length === 0) continue;   // one Live read per device adds up; skip the rest
    const on = d.parameters.find((x) => x.name === DEVICE_ON);
    if (on && (await on.getValue()) < 0.5) continue;
    if (external) out.push(d.name);
    for (const c of chains) out.push(...(await enabledRealtimeDevices(c.devices)));
  }
  return out;
}

/**
 * Snapshot of the open Set, with each Master device's real Device On state resolved and the switched-on
 * External devices on tracks and returns listed. The Main track's are not: the run bypasses its devices.
 */
export async function snapshotFromContext(context: Ctx, songName: string): Promise<SongSnapshot> {
  const song = context.application.song;
  const master = song.mainTrack;
  const devices = await Promise.all(
    master.devices.map(async (d) => ({
      name: d.name,
      enabled: (await deviceOn(d).getValue()) >= 0.5,
    })),
  );
  const tracks = song.tracks;   // read once: snapshot keys below are aligned to these by index
  const snap = snapshotSong(
    {
      tracks,
      mainTrack: { name: master.name, mute: master.mute, groupTrack: null, devices },
    },
    songName,
  );
  const realtime: RealtimeDevice[] = [];
  for (const [i, t] of tracks.entries())
    for (const device of await enabledRealtimeDevices(t.devices)) realtime.push({ where: snap.tracks[i].key, device });
  for (const t of song.returnTracks)
    for (const device of await enabledRealtimeDevices(t.devices)) realtime.push({ where: `${t.name} (return)`, device });
  return { ...snap, realtime };
}

/**
 * Maps snapshot keys onto live tracks by re-running snapshotSong's own key rule over them
 * (parent key + name, `#n` only for same-parent duplicates, in track order), so the rule
 * cannot drift from snapshot.ts. Throws if the Set no longer matches the snapshot.
 */
export function matchTracks<T extends TrackLike>(
  live: readonly T[], snapshot: SongSnapshot,
): Map<string, T> {
  const view = snapshotSong(
    { tracks: live, mainTrack: { name: "", mute: false, groupTrack: null, devices: [] } },
    snapshot.song,
  );
  const want = snapshot.tracks.map((t) => t.key);
  const got = view.tracks.map((t) => t.key);
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) {
    throw new Error("The Live Set's tracks changed since the snapshot was taken; re-open the export.");
  }
  return new Map(got.map((k, i) => [k, live[i]]));
}

export function bridgeFromContext(context: Ctx, snapshot: SongSnapshot): LiveBridge {
  const song = context.application.song;
  // Sanity check only: `snapshot` was taken moments ago, so this confirms the live track list and
  // snapshotSong's key rule still agree. It cannot see edits made while the mapping dialog was open;
  // configure catches those by re-validating the mapping against a fresh snapshot.
  matchTracks<Track<"1.0.0">>(song.tracks, snapshot);

  return {
    // Keys are re-derived from the live Set on every call, so a rename mid-run surfaces as a
    // missing key (applyPass refuses; restore reports it) instead of muting the wrong track.
    async tracks(): Promise<LiveTrack[]> {
      const live = song.tracks;   // read once: keys below are aligned to these by index
      const view = snapshotSong(
        { tracks: live, mainTrack: { name: "", mute: false, groupTrack: null, devices: [] } },
        snapshot.song,
      );
      return live.map((t, i) => ({
        key: view.tracks[i].key,
        getMute: () => t.mute,
        setMute: (v: boolean) => { t.mute = v; },
        getSolo: () => t.solo,
        setSolo: (v: boolean) => { t.solo = v; },
      }));
    },
    async returnTracks(): Promise<LiveTrack[]> {
      const live = song.returnTracks;   // read once; keys are aligned by index
      const keys = ordinalKeys(live.map((t) => t.name));
      return live.map((t, i) => ({
        key: `return:${keys[i]}`,
        getMute: () => t.mute,
        setMute: (v: boolean) => { t.mute = v; },
        getSolo: () => t.solo,
        setSolo: (v: boolean) => { t.solo = v; },
      }));
    },
    async masterDevices(): Promise<LiveMasterDevice[]> {
      return song.mainTrack.devices.map((d) => {
        const on = deviceOn(d); // throws here, at capture time, for a device we cannot bypass
        return {
          name: d.name,
          isEnabled: async () => (await on.getValue()) >= 0.5,
          setEnabled: (v: boolean) => on.setValue(v ? 1 : 0),
        };
      });
    },
    async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
      // The SDK callback must be synchronous: mutations have to be STARTED inside fn.
      return await context.withinTransaction(fn);
    },
  };
}

const MAPPING_SIZE = { width: 1360, height: 760 };
const MESSAGE_SIZE = { width: 520, height: 320 };

/** A modal message; resolves with the id of the button pressed. Independent of storage/temp directories. */
export function showMessage(context: Ctx, m: MessageSpec): Promise<string> {
  return context.ui.showModalDialog(messageUrl(m), MESSAGE_SIZE.width, MESSAGE_SIZE.height);
}

/** The real Host: Live's snapshot, bridge and dialogs. Not exercised against a real Live yet. */
export function hostFromContext(context: Ctx): Host {
  const { storageDirectory, tempDirectory } = context.environment;
  if (!storageDirectory || !tempDirectory) {
    throw new Error(
      "Live gave this extension no storage or temp directory; it cannot run. " +
      "If you launched it with `extensions-cli run`, pass --storage-directory and --temp-directory " +
      "(`npm start` does this for you).",
    );
  }
  return {
    storageDir: storageDirectory,
    tempDir: tempDirectory,
    snapshot: (song) => snapshotFromContext(context, song),
    bridge: (snapshot) => bridgeFromContext(context, snapshot),
    taps: () => bridgeTaps(),
    showMapping: (url) => context.ui.showModalDialog(url, MAPPING_SIZE.width, MAPPING_SIZE.height),
    message: (m) => showMessage(context, m),
  };
}
