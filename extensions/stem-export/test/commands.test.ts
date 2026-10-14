import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, sumAudio, writeWav24, type Audio } from "../src/audio.js";
import {
  Commands, check, collectRender, manifestFromResponse, pendingRenders, requestFor, runRecords,
  snapshotTemp, type Host, type Settle,
} from "../src/commands.js";
import { registerAll } from "../src/extension.js";
import { emptyManifest, loadManifest, manifestPath, saveManifest } from "../src/manifest.js";
import { loadRunState, runStatePath, saveRunState, type LiveBridge, type RunState } from "../src/run.js";
import { snapshotFromData, snapshotSong, type TrackLike } from "../src/snapshot.js";
import type { MessageSpec } from "../src/ui/message.js";
import type { MappingRequest } from "../src/ui/protocol.js";

/** What the dialog page shows for a request on open: the same call the page makes (the host sends no findings). */
function pageFindings(req: MappingRequest) {
  const manifest = manifestFromResponse(
    req.base, { cancelled: false, song: req.song, assignments: req.current.assignments, extras: req.current.extras }, req.song);
  return check(snapshotFromData(req.snapshot), manifest, req.taps).findings;
}

// ------------------------------------------------------------------ registration

function fakeActivation() {
  const commands = new Map<string, Function>();
  const menu: { scope: string; title: string; id: string }[] = [];
  return {
    commands, menu,
    context: {
      commands: { registerCommand: (id: string, cb: Function) => void commands.set(id, cb) },
      ui: {
        registerContextMenuAction: async (scope: string, title: string, id: string) =>
          void menu.push({ scope, title, id }),
        showModalDialog: vi.fn(),
        withinProgressDialog: vi.fn(),
      },
      environment: { storageDirectory: "/tmp/s", tempDirectory: "/tmp/t" },
      application: { song: { tracks: [], mainTrack: { name: "Main", mute: false, groupTrack: null, devices: [] } } },
      withinTransaction: async (fn: Function) => fn(),
    },
  };
}

describe("extension registration", () => {
  it("registers all four commands", () => {
    const f = fakeActivation();
    registerAll(f.context as never);
    expect([...f.commands.keys()].sort()).toEqual(
      ["stem-export.abort", "stem-export.configure", "stem-export.finish", "stem-export.next"]);
  });

  it("registers every command on both track scopes", () => {
    const f = fakeActivation();
    registerAll(f.context as never);
    expect(new Set(f.menu.map((m) => m.scope))).toEqual(new Set(["AudioTrack", "MidiTrack"]));
    for (const id of f.commands.keys()) {
      expect(f.menu.filter((m) => m.id === id).map((m) => m.scope).sort()).toEqual(["AudioTrack", "MidiTrack"]);
    }
    expect(f.menu.find((m) => m.id === "stem-export.configure")!.title).toBe("Stem Export…");
  });

  it("a failing command is reported in a dialog rather than swallowed", async () => {
    const f = fakeActivation();
    f.context.environment.storageDirectory = undefined as never;   // hostFromContext will throw
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerAll(f.context as never);
    await f.commands.get("stem-export.next")!();
    expect(f.context.ui.showModalDialog).toHaveBeenCalledTimes(1);
    const url = f.context.ui.showModalDialog.mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain("no storage or temp directory");
    err.mockRestore();
  });
});

// ---------------------------------------------------------------- a fake Live + Host

const SR = 48000;
const tone = (freq: number, amp = 0.1): Audio => {
  const ch = new Float64Array(SR);
  for (let i = 0; i < SR; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { channels: [ch, Float64Array.from(ch)], sampleRate: SR, frames: SR };
};
const TONES: Record<string, Audio> = { Kick: tone(220), Bass: tone(330), Pad: tone(440) };

interface FakeTrack extends TrackLike { solo: boolean }

function fakeLive(opts: {
  muted?: string[]; soloed?: string[]; master?: { name: string; on: boolean }[];
  /** Puts Bass and Pad inside a group "Arps" that carries a Glue Compressor (keys Kick, Arps, Arps/Bass, Arps/Pad). */
  processedGroup?: boolean;
  /** Extra top-level tracks (keys are their names), for Sets big enough to hold a long saved mapping. */
  extra?: string[];
} = {}) {
  const arps: FakeTrack | null = opts.processedGroup
    ? { name: "Arps", mute: false, solo: false, groupTrack: null, devices: [{ name: "Glue Compressor" }] } : null;
  const tracks: FakeTrack[] = ["Kick", "Bass", "Pad"].map((name) => ({
    name, mute: opts.muted?.includes(name) ?? false, solo: opts.soloed?.includes(name) ?? false,
    groupTrack: arps && name !== "Kick" ? arps : null, devices: [],
  }));
  if (arps) tracks.splice(1, 0, arps);
  for (const name of opts.extra ?? []) tracks.push({ name, mute: false, solo: false, groupTrack: null, devices: [] });
  // Bridge keys are the snapshot's own, re-derived on every call like the real bridge (so a rename shows).
  const keysNow = () => snapshotSong({ tracks, mainTrack: { name: "Main", mute: false, groupTrack: null, devices: [] } }, "S")
    .tracks.map((t) => t.key);
  const master = (opts.master ?? [{ name: "Limiter", on: false }]).map((d) => ({ ...d }));
  let inTx = false;
  const bridge: LiveBridge = {
    tracks: async () => { const keys = keysNow(); return tracks.map((t, i) => ({
      key: keys[i],
      getMute: () => t.mute, setMute: (v: boolean) => { if (!inTx) throw new Error("outside tx"); t.mute = v; },
      getSolo: () => t.solo, setSolo: (v: boolean) => { if (!inTx) throw new Error("outside tx"); t.solo = v; },
    })); },
    returnTracks: async () => [],
    masterDevices: async () => master.map((d) => ({
      name: d.name,
      isEnabled: async () => d.on,
      setEnabled: async (v: boolean) => { if (!inTx) throw new Error("outside tx"); d.on = v; },
    })),
    transaction: async <T,>(fn: () => T | Promise<T>) => {
      inTx = true;
      let r: T | Promise<T>;
      try { r = fn(); } finally { inTx = false; }
      return r;
    },
  };
  return {
    tracks, master, bridge,
    mutes: () => Object.fromEntries(tracks.map((t) => [t.name, t.mute])),
    song: (name: string) => snapshotSong(
      { tracks, mainTrack: { name: "Main", mute: false, groupTrack: null, devices: master.map((d) => ({ name: d.name, enabled: d.on })) } },
      name),
  };
}

function makeHost(live: ReturnType<typeof fakeLive>, script: {
  mapping?: (req: MappingRequest) => unknown;   // a string is passed through raw
  settle?: Settle;
  buttons?: string[];   // answers to messages, in order; default is the first button
} = {}) {
  const storageDir = mkdtempSync(join(tmpdir(), "sk-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "sk-temp-"));
  const messages: MessageSpec[] = [];
  const requests: MappingRequest[] = [];
  const answers = [...(script.buttons ?? [])];
  const host: Host = {
    storageDir, tempDir,
    snapshot: async (song) => live.song(song),
    bridge: () => live.bridge,
    taps: () => [],
    showMapping: async (url) => {
      const html = decodeURIComponent(url.replace("data:text/html,", ""));
      const m = /window\.__REQUEST__=(.*?);<\/script>/s.exec(html)!;
      const req = JSON.parse(m[1]) as MappingRequest;
      requests.push(req);
      const reply = script.mapping ? script.mapping(req) : { cancelled: true };
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
    // Tests do not wait: a file counts as finished at once unless a test asks otherwise.
    settle: script.settle ?? { quietMs: 0, settleMs: 0, sleep: async () => {}, now: () => Date.now() },
    message: async (m) => { messages.push(m); return answers.shift() ?? (m.buttons?.[0]?.id ?? "ok"); },
  };
  return { host, storageDir, tempDir, messages, requests, cmds: new Commands(host) };
}

const DRUMS_BASS = () => ({
  cancelled: false, song: "Untitled Set", assignments: { Kick: "Drums", Bass: "Keys - Played" }, extras: [],
});
const text = (m: MessageSpec) => `${m.title}\n${m.lines.join("\n")}`;

/** "Export" in the fake Live: renders whatever is unmuted into the export folder, always as Untitled.wav. */
function exportNow(live: ReturnType<typeof fakeLive>, tempDir: string) {
  const heard = live.tracks.filter((t) => !t.mute && !t.solo || t.solo).map((t) => TONES[t.name]);
  writeWav24(join(tempDir, "Untitled.wav"), sumAudio(heard));
}

/** The same fake mix, rendered at another sample rate (a 44.1 kHz Set, say). One second of audio. */
function exportNowAt(live: ReturnType<typeof fakeLive>, tempDir: string, rate: number) {
  const mk = (freq: number): Audio => {
    const ch = new Float64Array(rate);
    for (let i = 0; i < rate; i++) ch[i] = 0.1 * Math.sin((2 * Math.PI * freq * i) / rate);
    return { channels: [ch, Float64Array.from(ch)], sampleRate: rate, frames: rate };
  };
  const at: Record<string, Audio> = { Kick: mk(220), Bass: mk(330), Pad: mk(440) };
  const heard = live.tracks.filter((t) => !t.mute && !t.solo || t.solo).map((t) => at[t.name]);
  writeWav24(join(tempDir, "Untitled.wav"), sumAudio(heard));
}

describe("configure", () => {
  it("snapshot -> dialog -> re-validate -> save manifest -> begin run -> apply pass 1", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(t.requests).toHaveLength(1);
    const state = loadRunState(runStatePath(t.storageDir, "Untitled Set"))!;
    expect(state.passes.map((p) => p.name)).toEqual(["Drums", "Keys - Played", "Backing", "— Master reference —"]);
    expect(state.passIndex).toBe(0);
    // Pass 1 (Drums = Kick) applied: Bass and Pad muted
    expect(live.mutes()).toEqual({ Kick: false, Bass: true, Pad: true });
    expect(existsSync(manifestPath(t.storageDir, "Untitled Set"))).toBe(true);
    expect(text(t.messages.at(-1)!)).toContain("Pass 1 of 4: Drums");
    expect(text(t.messages.at(-1)!)).toContain(t.tempDir);
  });

  it("cancelling the dialog changes nothing", async () => {
    const live = fakeLive();
    const t = makeHost(live);
    await t.cmds.configure();
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(existsSync(manifestPath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });
  });

  it("BLOCKS on a mapping the dialog's own findings never saw (host re-validates)", async () => {
    const live = fakeLive();
    const t = makeHost(live, {
      mapping: () => ({ cancelled: false, song: "Untitled Set", assignments: { Kick: "Drums", Ghost: "Drums" }, extras: [] }),
    });
    await t.cmds.configure();
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });
    expect(text(t.messages.at(-1)!)).toMatch(/Cannot start the export[\s\S]*Ghost[\s\S]*mapping was saved/);
    // The mapping survives the error (it is the extension's own storage; the Set is untouched).
    expect(JSON.parse(readFileSync(manifestPath(t.storageDir, "Untitled Set"), "utf8")).stems.Drums.trackKeys)
      .toEqual(["Kick", "Ghost"]);
  });

  it("an enabled Master device is bypassed for the run and restored by Abort", async () => {
    const live = fakeLive({ master: [{ name: "Limiter", on: true }, { name: "EQ", on: false }] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(pageFindings(t.requests[0]).find((f) => f.rule === "master-live")!.severity).toBe("info");
    expect(live.master.map((d) => d.on)).toEqual([false, false]);   // bypassed for the run
    await t.cmds.abort();
    expect(live.master.map((d) => d.on)).toEqual([true, false]);    // exactly as found
  });

  it("an enabled Master device is bypassed for the run and restored by Finish", async () => {
    const live = fakeLive({ muted: ["Pad"], master: [{ name: "Limiter", on: true }, { name: "EQ", on: false }] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(live.master.map((d) => d.on)).toEqual([false, false]);
    exportNow(live, t.tempDir); await t.cmds.next();
    expect(live.master.map((d) => d.on)).toEqual([false, false]);   // still bypassed mid-run
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.finish();
    expect(t.messages.at(-1)!.title).toBe("Stem Export: finished");
    expect(live.master.map((d) => d.on)).toEqual([true, false]);
  });

  it("renaming in the dialog (and choosing Replace it) starts from any manifest already saved under the new name", async () => {
    const live = fakeLive();
    // Typing a name that already has a mapping now asks first; "Replace it" is the path that carries its targets over.
    const t = makeHost(live, { mapping: () => ({ ...DRUMS_BASS(), song: "Other" }), buttons: ["replace"] });
    const existing = { ...emptyManifest("Other"), targetLufs: -14 };
    existing.stems.Drums = { trackKeys: ["old"], suffix: " - Played" };
    saveManifest(existing, manifestPath(t.storageDir, "Other"));
    await t.cmds.configure();
    const saved = JSON.parse(readFileSync(manifestPath(t.storageDir, "Other"), "utf8"));
    expect(saved.targetLufs).toBe(-14);
    expect(saved.stems.Drums).toEqual({ trackKeys: ["Kick"], suffix: " - Played" });
  });

  it("an empty reply from the dialog is a cancel: no error, nothing changed", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: () => "" });
    await t.cmds.configure();
    expect(t.messages).toEqual([]);
    expect(existsSync(manifestPath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(runRecords(t.storageDir)).toEqual([]);
  });

  it("the song name comes from the dialog: it names the manifest, run and files", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: () => ({ ...DRUMS_BASS(), song: "Edited Name" }) });
    await t.cmds.configure();
    expect(existsSync(manifestPath(t.storageDir, "Edited Name"))).toBe(true);
    expect(existsSync(manifestPath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(loadRunState(runStatePath(t.storageDir, "Edited Name"))!.passes[0].outputName).toBe("Edited Name (Drums).wav");
    expect(text(t.messages.at(-1)!)).toContain(join(t.storageDir, "out", "Edited Name"));
  });

  it("sends EFFECTIVE mutedness (children of a muted group) from the snapshot, not the raw flag", () => {
    const grp: TrackLike = { name: "Old", mute: true, groupTrack: null, devices: [] };
    const kid: TrackLike = { name: "Kid", mute: false, groupTrack: grp, devices: [] };
    const snap = snapshotSong({ tracks: [grp, kid], mainTrack: { name: "M", mute: false, groupTrack: null, devices: [] } }, "S");
    const req = requestFor(snap, emptyManifest("S"), "/t", []);
    expect(req.snapshot.tracks.map((x) => [x.key, x.effectiveMuted, x.groupPath.length])).toEqual([["Old", true, 0], ["Old/Kid", true, 1]]);
  });

  it("shows the default-song-name note in the dialog's findings", async () => {
    const t = makeHost(fakeLive());
    await t.cmds.configure();
    expect(t.requests[0].notes.some((f) => f.rule === "song-name-default" && f.detail.includes("Song field"))).toBe(true);
  });

  it("seeds the dialog from the saved manifest on the next run", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    await t.cmds.abort();
    await t.cmds.configure();
    expect(t.requests[1].current.assignments).toEqual({ Kick: "Drums", Bass: "Keys - Played" });
  });
});

describe("saved assignments that no longer match a track", () => {
  // The saved mapping is found by its tracks (see "which saved mapping opens"), so each case seeds one
  // that still matches the Set (at least 2 tracks and 60 percent) and adds the stale keys on top.
  const seed = (t: ReturnType<typeof makeHost>, keys: string[], extra?: Partial<ReturnType<typeof emptyManifest>>) => {
    const m = { ...emptyManifest("Untitled Set"), ...extra };
    m.stems.Drums = { trackKeys: keys, suffix: " - Played" };
    saveManifest(m, manifestPath(t.storageDir, "Untitled Set"));
  };
  const staleNote = (t: ReturnType<typeof makeHost>) => t.requests[0].notes.filter((f) => f.rule === "stale-keys");
  /** 21 live tracks, so a long run of stale keys still leaves 60 percent of the mapping matching. */
  const BIG = Array.from({ length: 18 }, (_, i) => `X${i + 1}`);
  const LIVE = ["Kick", "Bass", "Pad", ...BIG];

  it("two stale keys and three valid: the dialog gets only the valid ones, one info note names both, no error", async () => {
    const t = makeHost(fakeLive());
    seed(t, ["Kick", "Bass", "Pad", "Ghost", "Old/Synth"]);   // 3 of 5 = exactly 60 percent
    await t.cmds.configure();
    const req = t.requests[0];
    expect(req.base.stems.Drums.trackKeys).toEqual(["Kick", "Bass", "Pad"]);
    expect(req.current.assignments).toEqual({ Kick: "Drums", Bass: "Drums", Pad: "Drums" });
    expect(staleNote(t)).toHaveLength(1);
    expect(staleNote(t)[0].severity).toBe("info");
    expect(staleNote(t)[0].detail).toBe(
      "2 saved assignments no longer match a track and are not shown (Ghost, Old/Synth); they are removed from the saved mapping when you continue.");
    const rules = [...pageFindings(req), ...req.notes].map((f) => f.rule);
    expect(rules).not.toContain("unresolved-ref");
  });

  it("one stale key uses the singular wording", async () => {
    const t = makeHost(fakeLive());
    seed(t, ["Kick", "Bass", "Ghost"]);
    await t.cmds.configure();
    expect(staleNote(t)[0].detail).toBe("1 saved assignment no longer matches a track and is not shown (Ghost); it is removed from the saved mapping when you continue.");
  });

  it("a long list is capped at 8 keys then 'and N more', and the count stays the true total", async () => {
    const t = makeHost(fakeLive({ extra: BIG }));
    const ghosts = Array.from({ length: 11 }, (_, i) => `Ghost ${i + 1}`);
    seed(t, [...LIVE, ...ghosts]);
    await t.cmds.configure();
    expect(staleNote(t)[0].detail).toBe(
      `11 saved assignments no longer match a track and are not shown (${ghosts.slice(0, 8).join(", ")}, and 3 more); ` +
      `they are removed from the saved mapping when you continue.`);
  });

  it("exactly 8 stale keys are all listed, with no 'more'", async () => {
    const t = makeHost(fakeLive({ extra: BIG }));
    const ghosts = Array.from({ length: 8 }, (_, i) => `Ghost ${i + 1}`);
    seed(t, [...LIVE, ...ghosts]);
    await t.cmds.configure();
    expect(staleNote(t)[0].detail).toBe(`8 saved assignments no longer match a track and are not shown (${ghosts.join(", ")}); ` +
      `they are removed from the saved mapping when you continue.`);
  });

  it("a key counts once even when two stems or an extra name it", async () => {
    const t = makeHost(fakeLive());
    seed(t, ["Kick", "Bass", "Ghost"]);
    const m = loadManifest(manifestPath(t.storageDir, "Untitled Set"))!;
    m.extras = [{ name: "Solo", trackKeys: ["Ghost"] }];
    m.stems.Vox = { trackKeys: ["Ghost"] };
    saveManifest(m, manifestPath(t.storageDir, "Untitled Set"));
    await t.cmds.configure();
    expect(staleNote(t)[0].detail).toMatch(/^1 saved assignment no longer matches/);
    expect(t.requests[0].base.extras[0].trackKeys).toEqual([]);
  });

  it("nothing dropped: no note", async () => {
    const t = makeHost(fakeLive());
    seed(t, ["Kick", "Bass"]);
    await t.cmds.configure();
    expect(staleNote(t)).toEqual([]);
  });

  it("a dropped key does not come back in the saved manifest, and a stem whose keys were all stale keeps its suffix", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: (req) => ({
      cancelled: false, song: req.song, assignments: { Kick: "Vox", Bass: "Vox", Pad: "Drums" }, extras: [] }) });
    seed(t, ["Ghost"]);   // every key of Drums is stale; its suffix must survive
    const m = loadManifest(manifestPath(t.storageDir, "Untitled Set"))!;
    m.stems.Vox = { trackKeys: ["Kick", "Bass", "Pad"] };   // the tracks that still match the Set (3 of 4)
    saveManifest(m, manifestPath(t.storageDir, "Untitled Set"));
    await t.cmds.configure();
    const saved = loadManifest(manifestPath(t.storageDir, "Untitled Set"))!;
    expect(JSON.stringify(saved)).not.toContain("Ghost");
    expect(saved.stems.Drums).toEqual({ trackKeys: ["Pad"], suffix: " - Played" });
  });

  it("a stale key does not stop the run: the host re-validation sees no error", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: (req) => ({
      cancelled: false, song: req.song, assignments: req.current.assignments, extras: [] }) });
    seed(t, ["Kick", "Bass", "Ghost"]);
    await t.cmds.configure();
    expect(text(t.messages.at(-1)!)).toContain("Pass 1 of");
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(true);
  });
});

// ------------------------------------------------- which saved mapping opens

describe("which saved mapping opens", () => {
  const saveFor = (t: ReturnType<typeof makeHost>, song: string, stems: Record<string, string[]>, mutate?: (m: ReturnType<typeof emptyManifest>) => void) => {
    const m = emptyManifest(song);
    for (const [stem, keys] of Object.entries(stems)) m.stems[stem] = { trackKeys: keys, suffix: " - Played" };
    mutate?.(m);
    saveManifest(m, manifestPath(t.storageDir, song));
  };
  const stale = (t: ReturnType<typeof makeHost>, i = 0) => t.requests[i].notes.filter((f) => f.rule === "stale-keys");

  it("THE REPORTED CASE: a saved T9 names tracks that are not in this Set, nothing matches", async () => {
    const t = makeHost(fakeLive());
    saveFor(t, "T9", { Drums: ["1-Group/track", "1-Group/aaaaa"] });
    await t.cmds.configure();
    const req = t.requests[0];
    expect(req.song).toBe("Untitled Set");
    expect(req.current.assignments).toEqual({});
    expect(req.base.song).toBe("Untitled Set");
    expect(Object.keys(req.base.stems)).toEqual(["Backing"]);
    expect(req.notes.filter((f) => f.rule === "stale-keys")).toEqual([]);
    expect(req.notes.map((f) => f.rule)).toEqual(["song-name-default"]);
    expect(JSON.stringify(req)).not.toContain("T9");
    expect(JSON.stringify(req)).not.toContain("1-Group");
  });

  it("a saved mapping that matches the open Set is loaded with its name and a note, and another song's unrelated mapping is ignored", async () => {
    const t = makeHost(fakeLive());
    saveFor(t, "Some Other Song", { Drums: ["Nope1", "Nope2", "Nope3"] });   // saved last, but nothing in it is in this Set
    saveFor(t, "Real Song", { Drums: ["Kick"], "Keys - Played": ["Bass", "Pad", "Gone"] });   // 3 of 4 are in the Set
    await t.cmds.configure();
    const req = t.requests[0];
    expect(req.song).toBe("Real Song");
    expect(req.current.assignments).toEqual({ Kick: "Drums", Bass: "Keys - Played", Pad: "Keys - Played" });
    const note = req.notes.find((f) => f.rule === "loaded-saved-mapping")!;
    expect(note.severity).toBe("info");
    expect(note.detail).toBe("Loaded the saved mapping for 'Real Song': 3 of its 4 tracks are in this Set. If this is a different song, type its name.");
    expect(req.notes.some((f) => f.rule === "song-name-default")).toBe(false);
    expect(stale(t)).toHaveLength(1);
    expect(JSON.stringify(req)).not.toContain("Some Other Song");
  });

  it("a saved file that cannot be read or is not a manifest is skipped and the dialog still opens", async () => {
    const t = makeHost(fakeLive());
    saveFor(t, "Real Song", { Drums: ["Kick", "Bass"] });
    const dir = join(t.storageDir, "manifests");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "wrongshape.json"), JSON.stringify({ song: "x", stems: { Drums: { trackKeys: "Kick" } }, extras: [] }));
    writeFileSync(join(dir, "noextras.json"), JSON.stringify({ song: "y", stems: { Drums: { trackKeys: ["Kick", "Bass"] } } }));
    await t.cmds.configure();
    expect(t.requests[0].song).toBe("Real Song");
  });
});

describe("typing a name that already has a saved mapping", () => {
  // Only one of its tracks is in the Set, so it is not recognised as this Set's and the dialog opens on "Untitled Set".
  const existing = (t: ReturnType<typeof makeHost>) => {
    const m = emptyManifest("Other");
    m.targetLufs = -14;
    m.stems.Drums = { trackKeys: ["Pad", "Gone"], suffix: " - Played" };
    m.extras = [{ name: "X", trackKeys: ["Kick", "Gone2"] }];
    saveManifest(m, manifestPath(t.storageDir, "Other"));
  };
  const typed = (song: string) => () =>
    ({ cancelled: false, song, assignments: { Kick: "Drums", Bass: "Keys - Played" }, extras: [] });
  const asks = (t: ReturnType<typeof makeHost>) => t.messages.filter((m) => m.title === "A saved mapping already exists");

  it("asks with Load it / Replace it / Cancel and says how many tracks the mapping names", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["cancel"] });
    existing(t);
    await t.cmds.configure();
    expect(asks(t)).toHaveLength(1);
    expect(asks(t)[0].buttons!.map((b) => [b.id, b.label])).toEqual([["load", "Load it"], ["replace", "Replace it"], ["cancel", "Cancel"]]);
    expect(text(asks(t)[0])).toContain("'Other' already has a saved mapping that names 4 tracks.");   // Pad, Gone, Kick, Gone2
  });

  it("Load it reopens the dialog seeded from that mapping (pruned, name prefilled) and does not ask again", async () => {
    let n = 0;
    const t = makeHost(fakeLive(), {
      buttons: ["load"],
      mapping: (req) => (++n === 1 ? typed("Other")() : { cancelled: false, song: "Other", assignments: req.current.assignments, extras: req.current.extras }),
    });
    existing(t);
    await t.cmds.configure();
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1].song).toBe("Other");
    expect(t.requests[0].song).toBe("Untitled Set");
    expect(t.requests[1].current.assignments).toEqual({ Pad: "Drums" });
    expect(t.requests[1].current.extras).toEqual([{ name: "X", trackKeys: ["Kick"] }]);
    expect(t.requests[1].notes.map((f) => f.rule)).toEqual(["stale-keys"]);   // "Gone" and "Gone2" were dropped
    expect(t.requests[1].notes[0].detail).toContain("(Gone, Gone2)");
    expect(asks(t)).toHaveLength(1);
    // The run starts exactly once, from the SECOND reply, keeping the loaded mapping's target and suffix.
    expect(runRecords(t.storageDir)).toHaveLength(1);
    expect(t.messages.filter((m) => m.title.startsWith("Stem Export: Pass"))).toHaveLength(1);
    const saved = loadManifest(manifestPath(t.storageDir, "Other"))!;
    expect(saved.targetLufs).toBe(-14);
    expect(saved.stems.Drums).toEqual({ trackKeys: ["Pad"], suffix: " - Played" });
    expect(saved.song).toBe("Other");
  });

  it("Load it then the same name again: asked only once, so it cannot loop", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["load", "load", "load"] });
    existing(t);
    await t.cmds.configure();
    expect(asks(t)).toHaveLength(1);
    expect(t.requests).toHaveLength(2);
  });

  it("Replace it carries on and saves what was just set over the old mapping, keeping its targets", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["replace"] });
    existing(t);
    await t.cmds.configure();
    expect(t.requests).toHaveLength(1);
    const saved = loadManifest(manifestPath(t.storageDir, "Other"))!;
    expect(saved.stems.Drums).toEqual({ trackKeys: ["Kick"], suffix: " - Played" });
    expect(saved.stems["Keys - Played"].trackKeys).toEqual(["Bass"]);
    expect(saved.extras).toEqual([]);
    expect(saved.targetLufs).toBe(-14);
    expect(runRecords(t.storageDir)).toHaveLength(1);
  });

  it("Cancel changes nothing: the old mapping stays, no run starts, the name is not remembered", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["cancel"] });
    existing(t);
    const before = readFileSync(manifestPath(t.storageDir, "Other"), "utf8");
    await t.cmds.configure();
    expect(readFileSync(manifestPath(t.storageDir, "Other"), "utf8")).toBe(before);
    expect(runRecords(t.storageDir)).toEqual([]);
    expect(t.messages.filter((m) => m.title.startsWith("Stem Export:"))).toEqual([]);
  });

  // ---- a file under the typed name that exists but cannot be used (must never crash configure after the dialog)
  const badFiles: [string, string][] = [
    ["valid song and stems but no extras", JSON.stringify({ song: "Other", stems: { Drums: { trackKeys: ["Pad"] } } })],
    ["a stem with no trackKeys", JSON.stringify({ song: "Other", stems: { Drums: {} }, extras: [] })],
    ["corrupt JSON", "{ not json"],
  ];
  for (const [label, body] of badFiles) {
    it(`${label} under the typed name: asks Replace it / Cancel only, and Replace saves a valid manifest`, async () => {
      const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["replace"] });
      mkdirSync(join(t.storageDir, "manifests"), { recursive: true });
      writeFileSync(manifestPath(t.storageDir, "Other"), body);
      await t.cmds.configure();
      const q = t.messages.find((m) => m.title === "A saved mapping exists but cannot be read")!;
      expect(q.buttons!.map((b) => b.id)).toEqual(["replace", "cancel"]);
      expect(text(q)).toContain("cannot be read");
      expect(text(q)).toContain("replaced if you continue");
      const saved = loadManifest(manifestPath(t.storageDir, "Other"))!;
      expect(saved.song).toBe("Other");
      expect(saved.stems.Drums.trackKeys).toEqual(["Kick"]);
      expect(Array.isArray(saved.extras)).toBe(true);
      expect(runRecords(t.storageDir)).toHaveLength(1);
    });

    it(`${label} under the typed name: Cancel leaves the file and starts nothing`, async () => {
      const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["cancel"] });
      mkdirSync(join(t.storageDir, "manifests"), { recursive: true });
      writeFileSync(manifestPath(t.storageDir, "Other"), body);
      await t.cmds.configure();
      expect(readFileSync(manifestPath(t.storageDir, "Other"), "utf8")).toBe(body);
      expect(runRecords(t.storageDir)).toEqual([]);
    });
  }

  for (const answer of ["garbage", ""]) {
    it(`an unrecognised answer (${JSON.stringify(answer)}) is not Replace: nothing saved, no run, Set untouched`, async () => {
      const live = fakeLive();
      const t = makeHost(live, { mapping: typed("Other"), buttons: [answer] });
      existing(t);
      const before = readFileSync(manifestPath(t.storageDir, "Other"), "utf8");
      await t.cmds.configure();
      expect(asks(t)).toHaveLength(1);
      expect(readFileSync(manifestPath(t.storageDir, "Other"), "utf8")).toBe(before);
      expect(readdirSync(join(t.storageDir, "manifests"))).toEqual(["Other.json"]);
      expect(runRecords(t.storageDir)).toEqual([]);
      expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });
      expect(t.messages.filter((m) => m.title.startsWith("Stem Export:"))).toEqual([]);
    });
  }

  it("the prompt says Replace overwrites the assignments and keeps the loudness target and stem suffixes", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other"), buttons: ["cancel"] });
    existing(t);
    await t.cmds.configure();
    expect(text(asks(t)[0])).toContain("overwrites that mapping's saved assignments");
    expect(text(asks(t)[0])).toContain("loudness target and stem suffixes are kept");
  });

  it("does not ask when the name is unchanged or is new", async () => {
    const a = makeHost(fakeLive(), { mapping: DRUMS_BASS });
    await a.cmds.configure();                         // "Untitled Set" in, "Untitled Set" out
    expect(asks(a)).toEqual([]);
    const b = makeHost(fakeLive(), { mapping: typed("Brand New") });
    existing(b);
    await b.cmds.configure();                         // a name with no saved mapping
    expect(asks(b)).toEqual([]);
    expect(existsSync(manifestPath(b.storageDir, "Brand New"))).toBe(true);
  });

  it("does not ask when the typed name is the saved mapping the Set was matched to", async () => {
    const t = makeHost(fakeLive(), { mapping: typed("Other") });
    const m = emptyManifest("Other");
    m.stems.Drums = { trackKeys: ["Kick", "Bass"] };
    saveManifest(m, manifestPath(t.storageDir, "Other"));
    await t.cmds.configure();
    expect(t.requests[0].song).toBe("Other");
    expect(asks(t)).toEqual([]);
  });
});

describe("warnings at run start", () => {
  const reply = (req: MappingRequest) => ({
    cancelled: false, song: req.song, assignments: { Kick: "Drums", "Arps/Bass": "Keys - Played" }, extras: [] });

  it("a split processed group is listed in the start message and the run goes ahead", async () => {
    const live = fakeLive({ processedGroup: true });
    const t = makeHost(live, { mapping: reply });
    await t.cmds.configure();
    const msg = t.messages.at(-1)!;
    expect(msg.title).toMatch(/^Stem Export: Pass 1 of/);
    expect(text(msg)).toContain("Warnings (the run goes ahead):");
    // The export folder comes first, so a few warnings cannot push it out of view.
    expect(text(msg).indexOf(t.tempDir)).toBeGreaterThan(-1);
    expect(text(msg).indexOf(t.tempDir)).toBeLessThan(text(msg).indexOf("Warnings (the run goes ahead):"));
    expect(text(msg)).toContain("Processed group is split across stems: ");
    expect(text(msg)).toContain("Group 'Arps' has devices (Glue Compressor)");
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(true);
  });

  it("info findings and a clean Set add no warnings line", async () => {
    const t = makeHost(fakeLive({ muted: ["Pad"] }), { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(text(t.messages.at(-1)!)).not.toContain("Warnings");
  });

  it("the same group kept whole in one stem is not a warning", async () => {
    const t = makeHost(fakeLive({ processedGroup: true }), { mapping: (req) => ({
      cancelled: false, song: req.song, assignments: { Kick: "Drums", "Arps/Bass": "Keys - Played", "Arps/Pad": "Keys - Played" }, extras: [] }) });
    await t.cmds.configure();
    expect(text(t.messages.at(-1)!)).not.toContain("Warnings");
  });
});

describe("a stem whose only track is muted", () => {
  const MUTED_MEMBER = () => ({
    cancelled: false, song: "Untitled Set",
    assignments: { Kick: "Drums", Pad: "Keys - Played" }, extras: [],
  });

  it("does not block: the stem is dropped from the plan and the assignment stays in the manifest", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: MUTED_MEMBER });
    await t.cmds.configure();
    expect(t.messages.some((m) => m.title === "Cannot start the export")).toBe(false);
    const state = loadRunState(runStatePath(t.storageDir, "Untitled Set"))!;
    expect(state.passes.map((p) => p.name)).toEqual(["Drums", "Backing", "— Master reference —"]);
    const saved = loadManifest(manifestPath(t.storageDir, "Untitled Set"))!;
    expect(saved.stems["Keys - Played"].trackKeys).toEqual(["Pad"]);
  });

  it("the assignment is offered back to the dialog on the next run", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: MUTED_MEMBER });
    await t.cmds.configure();
    await t.cmds.abort();
    await t.cmds.configure();
    expect(t.requests[1].current.assignments.Pad).toBe("Keys - Played");
    expect(pageFindings(t.requests[1]).some((f) => f.rule === "empty-stem")).toBe(false);
  });
});

describe("a leftover run state", () => {
  it("same song: offers to restore, restores the Set, and starts over", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(live.mutes()).toEqual({ Kick: false, Bass: true, Pad: true });
    await t.cmds.configure();   // first button on the confirm is "Restore and start over"
    const titles = t.messages.map((m) => m.title);
    expect(titles).toContain("A run is already in progress");
    // Restored to the author's state (Pad muted) and then pass 1 applied again.
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.author.mutes.Pad).toBe(true);
    expect(live.mutes()).toEqual({ Kick: false, Bass: true, Pad: true });
  });

  it("same song, declined: Set and record untouched, dialog never opens", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    t.messages.length = 0;
    const before = live.mutes();
    const answers = ["cancel"];
    t.host.message = async (m) => { t.messages.push(m); return answers.shift() ?? "ok"; };
    await t.cmds.configure();
    expect(t.requests).toHaveLength(1);
    expect(live.mutes()).toEqual(before);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))).not.toBeNull();
  });

  /** A record whose tracks are not in the open Set at all (another project's, or tracks since renamed). */
  function foreignRecord(t: ReturnType<typeof makeHost>) {
    const s: RunState = {
      song: "Other Project", passIndex: 0, collected: {},
      passes: [{ kind: "stem", name: "Drums", include: [], exclude: [], outputName: "x.wav" }],
      author: { mutes: { Zither: true, Harp: true }, solos: {}, returnSolos: {}, masterEnabled: {} },
    };
    const path = runStatePath(t.storageDir, "Other Project");
    saveRunState(s, path);
    return path;
  }

  it("a record that does not match the Set: says so, touches nothing, offers discard", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["restart", "cancel"] });
    const path = foreignRecord(t);
    await t.cmds.configure();
    const m = t.messages.find((x) => x.title === "This run does not match the open Set")!;
    expect(m.buttons!.map((b) => b.id)).toEqual(["restore", "discard", "cancel"]);
    expect(text(m)).toContain("Zither");
    expect(existsSync(path)).toBe(true);          // declined: kept
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });
    expect(t.requests).toHaveLength(0);
  });

  it("a record that does not match, discarded: the record goes, Live is untouched, configure proceeds", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["restart", "discard"] });
    const path = foreignRecord(t);
    await t.cmds.configure();
    expect(existsSync(path)).toBe(false);
    expect(t.requests).toHaveLength(1);
    expect(runRecords(t.storageDir).map((r) => r.state!.song)).toEqual(["Untitled Set"]);
  });

  it("a corrupt record can be discarded", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["discard"] });
    const path = runStatePath(t.storageDir, "Anything");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json");
    await t.cmds.configure();
    expect(t.messages[0].title).toBe("Unreadable run record");
    expect(t.requests).toHaveLength(1);
  });
});

describe("the manual loop", () => {
  it("runs configure -> export -> next ... -> finish, restoring the Set and writing a nulled folder", async () => {
    const live = fakeLive({ muted: ["Pad"] });   // Pad is the author's own mute: held out, never in a stem
    live.master.push({ name: "EQ", on: false });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    // passes: Drums(Kick), Bass(Bass), Master reference. Backing is empty (Pad muted) and skipped.
    const state0 = loadRunState(runStatePath(t.storageDir, "Untitled Set"))!;
    expect(state0.passes.map((p) => p.name)).toEqual(["Drums", "Keys - Played", "— Master reference —"]);

    exportNow(live, t.tempDir);   // every pass reuses the SAME file name
    await t.cmds.next();
    expect(live.mutes()).toEqual({ Kick: true, Bass: false, Pad: true });
    exportNow(live, t.tempDir);
    await t.cmds.next();
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: true });   // master reference: everything audible
    expect(text(t.messages.at(-1)!)).toContain("Stem Export: Finish");
    exportNow(live, t.tempDir);
    await t.cmds.finish();

    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: true });   // exactly the author's
    expect(live.master.map((d) => d.on)).toEqual([false, false]);
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(false);

    const out = join(t.storageDir, "out", "Untitled Set");
    expect(readdirSync(out).sort()).toEqual([
      "Untitled Set (Drums).wav", "Untitled Set (Keys - Played).wav", "Untitled Set (MASTER REFERENCE).wav"]);
    const done = t.messages.at(-1)!;
    expect(done.title).toBe("Stem Export: finished");
    expect(text(done)).toContain(out);
    expect(text(done)).toMatch(/Null test residual: -\d+\.\d dBFS/);
    // sum(stems) == master on disk: one gain across all of them
    const w = (n: string) => readWav(join(out, `Untitled Set (${n}).wav`));
    const sum = sumAudio([w("Keys - Played"), w("Drums")]), ref = w("MASTER REFERENCE");
    expect(Math.abs(sum.channels[0][4321] - ref.channels[0][4321])).toBeLessThan(1e-5);
  });

  it("the Finish dialog shows a 'passes, but not exact' note, as a note and not a problem", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    // The Master render carries a little something the stems do not: -98 dBFS, like the Glue Compressor split.
    const mix = sumAudio([TONES.Kick, TONES.Bass]);
    writeWav24(join(t.tempDir, "Untitled.wav"),
      { ...mix, channels: mix.channels.map((c) => c.map((v) => v + 10 ** (-98 / 20))) });
    await t.cmds.finish();
    const done = t.messages.at(-1)!;
    expect(done.title).toBe("Stem Export: finished");
    expect(done.lines.filter((l) => l.startsWith("Note: "))).toHaveLength(1);
    expect(text(done)).toContain("sidechain");
    expect(text(done)).toContain("Most likely something nonlinear");
    expect(text(done)).not.toContain("PROBLEM");
  });

  it("a clean run shows no such note", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.finish();
    expect(t.messages.at(-1)!.lines.some((l) => l.startsWith("Note: "))).toBe(false);
  });

  it("records the applied gain in the manifest at Finish", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(loadManifest(manifestPath(t.storageDir, "Untitled Set"))!.appliedGainDb).toBeNull();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.finish();
    expect(t.messages.at(-1)!.title).toBe("Stem Export: finished");
    const gain = loadManifest(manifestPath(t.storageDir, "Untitled Set"))!.appliedGainDb;
    expect(typeof gain).toBe("number");
    expect(text(t.messages.at(-1)!)).toContain(`${gain!.toFixed(2)} dB`);
  });

  it("restores the author's solo and Master device bypass too", async () => {
    const live = fakeLive({ soloed: ["Pad"], master: [{ name: "Limiter", on: false }] });
    // A soloed Pad would mute everything else in Live; the run clears it, finish puts it back.
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(live.tracks.map((x) => x.solo)).toEqual([false, false, false]);
    await t.cmds.abort();
    expect(live.tracks.map((x) => x.solo)).toEqual([false, false, true]);
  });

  it("next without a render in the export folder fails clearly and changes nothing", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    const mutes = live.mutes();
    await expect(t.cmds.next()).rejects.toThrow(/No new render found/);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(0);
    expect(live.mutes()).toEqual(mutes);
  });

  it("a double Next cannot skip a pass that was never exported", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir);
    await t.cmds.next();
    await expect(t.cmds.next()).rejects.toThrow(/No new render found/);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(1);
  });

  it("two unclaimed renders are ambiguous: refused, nothing moved", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    writeWav24(join(t.tempDir, "a.wav"), TONES.Kick);
    writeWav24(join(t.tempDir, "b.wav"), TONES.Bass);
    await expect(t.cmds.next()).rejects.toThrow(/More than one new audio file/);
    expect(readdirSync(t.tempDir).sort()).toEqual(["a.wav", "b.wav"]);
  });

  it("ignores audio that was already in the export folder when the run began", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    writeWav24(join(t.tempDir, "old-render.wav"), TONES.Pad);
    await t.cmds.configure();
    await expect(t.cmds.next()).rejects.toThrow(/No new render found/);
    exportNow(live, t.tempDir);
    await t.cmds.next();   // only Untitled.wav was claimed
    expect(existsSync(join(t.tempDir, "old-render.wav"))).toBe(true);
  });

  it("finish before every pass is exported changes nothing", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    const mutes = live.mutes();
    exportNow(live, t.tempDir);
    await t.cmds.finish();
    expect(text(t.messages.at(-1)!)).toMatch(/Not every pass[\s\S]*Keys - Played/);
    expect(live.mutes()).toEqual(mutes);   // still mid-run, not restored
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))).not.toBeNull();
  });

  it("next on the last pass points at Finish", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    await t.cmds.next();
    expect(t.messages.at(-1)!.title).toBe("That was the last pass");
  });

  it("commands with no run in progress say so", async () => {
    const t = makeHost(fakeLive());
    await t.cmds.next();
    await t.cmds.finish();
    await t.cmds.abort();
    expect(t.messages.map((m) => m.title)).toEqual(["No export in progress", "No export in progress", "No export in progress"]);
  });
});

describe("a run is found by scanning runs/, not by the song name", () => {
  it("abort restores the Set from the run record alone", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(live.mutes()).toEqual({ Kick: false, Bass: true, Pad: true });
    await t.cmds.abort();
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: true });
    expect(runRecords(t.storageDir)).toEqual([]);
    expect(t.messages.at(-1)!.title).toBe("Export aborted");
  });

  it("next and finish also keep working, using the name the run began with", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: () => ({ ...DRUMS_BASS(), song: "Original" }) });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.finish();
    expect(readdirSync(join(t.storageDir, "out"))).toEqual(["Original"]);
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: true });
  });

  it("a later configure restores the old run first, so its baseline is the author's, not the muted Set", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    let n = 0;
    const t = makeHost(live, { mapping: () => ({ ...DRUMS_BASS(), song: ++n === 1 ? "Untitled Set" : "Different"  }) });
    await t.cmds.configure();
    await t.cmds.configure();   // default answer: "Restore and start over"; the new run is under another name
    expect(t.messages.some((m) => m.title === "A run is already in progress")).toBe(true);
    expect(runRecords(t.storageDir).map((r) => r.state!.author.mutes)).toEqual([{ Kick: false, Bass: false, Pad: true }]);
  });
});

describe("finish failures and cleanup", () => {
  it("keeps the record and the collected renders when finalize is not clean, so Finish can be retried", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), TONES.Pad);   // a Master that does NOT equal the stems: the null test fails
    await t.cmds.finish();
    expect(t.messages.at(-1)!.title).toBe("Stem Export: finished with problems");
    expect(text(t.messages.at(-1)!)).toMatch(/null-failed/);
    expect(runRecords(t.storageDir)).toHaveLength(1);
    expect(readdirSync(join(t.tempDir, "collected", "Untitled Set"))).toHaveLength(3);
    // Retry succeeds once the Master reference is replaced by a good render.
    const rec = runRecords(t.storageDir)[0];
    const good = sumAudio([TONES.Kick, TONES.Bass]);
    writeWav24(rec.state!.collected["— Master reference —"], good);
    await t.cmds.finish();
    expect(t.messages.at(-1)!.title).toBe("Stem Export: finished");
    expect(runRecords(t.storageDir)).toEqual([]);
  });

  it("a failed null test does not tell the user to run Finish again: it says to Abort and re-export", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), TONES.Pad);   // the null test fails
    await t.cmds.finish();
    const out = text(t.messages.at(-1)!);
    expect(out).toMatch(/null-failed/);
    expect(out).not.toContain("run Stem Export: Finish again");
    expect(out).toContain("running Stem Export: Finish again will not change that result");
    expect(out).toContain("Stem Export: Abort");
    expect(out).toContain("processed group split across stems");
  });

  it("a clipped problem keeps the old wording (Finish again is still the way forward)", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: (req) => ({ ...DRUMS_BASS(), song: req.song, extras: [{ name: "Hot", trackKeys: ["Kick"] }] }) });
    await t.cmds.configure();
    // Quiet stems that sum exactly to the Master reference (so the null passes) get a large song gain, and an
    // extra at 0.5 then lands over full scale.
    const kick = tone(220, 0.01), bass = tone(330, 0.01);
    writeWav24(join(t.tempDir, "Untitled.wav"), kick); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), bass); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), sumAudio([kick, bass])); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), tone(440, 0.5));
    await t.cmds.finish();
    const out = text(t.messages.at(-1)!);
    expect(out).toMatch(/PROBLEM \(clipped\)/);
    expect(out).not.toMatch(/null-failed/);
    expect(out).toContain("Not clean. The run is kept: fix the above and run Stem Export: Finish again, or Stem Export: Abort to discard it.");
  });

  it("removes the collected renders from temp on success and on abort", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    expect(existsSync(join(t.tempDir, "collected", "Untitled Set"))).toBe(true);
    await t.cmds.abort();
    expect(existsSync(join(t.tempDir, "collected", "Untitled Set"))).toBe(false);

    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.finish();
    expect(t.messages.at(-1)!.title).toBe("Stem Export: finished");
    expect(existsSync(join(t.tempDir, "collected", "Untitled Set"))).toBe(false);
  });

  it("Next while Live is still writing the render fails without moving anything", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, settle: { quietMs: 60_000, settleMs: 0, sleep: async () => {}, now: () => Date.now() } });
    await t.cmds.configure();
    exportNow(live, t.tempDir);
    await expect(t.cmds.next()).rejects.toThrow(/Export still running/);
    expect(existsSync(join(t.tempDir, "Untitled.wav"))).toBe(true);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(0);
  });
});

describe("finish when the Set cannot be fully restored", () => {
  it("still writes the stems, reports the restore failure, and keeps the run record", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir);
    live.tracks[2].name = "Pad (renamed)";   // the author renames a track between the last Export and Finish
    await t.cmds.finish();

    const done = t.messages.at(-1)!;
    expect(done.title).toBe("Stem Export: finished with problems");
    expect(text(done)).toMatch(/PROBLEM \(restore\)[\s\S]*Pad/);
    expect(text(done)).not.toContain("are back as you left them");
    expect(readdirSync(join(t.storageDir, "out", "Untitled Set")).sort()).toEqual([
      "Untitled Set (Drums).wav", "Untitled Set (Keys - Played).wav", "Untitled Set (MASTER REFERENCE).wav"]);
    expect(runRecords(t.storageDir)).toHaveLength(1);   // kept, so Abort can still restore what it finds
    expect(typeof loadManifest(manifestPath(t.storageDir, "Untitled Set"))!.appliedGainDb).toBe("number");
  });
});

describe("renders are validated as they are collected", () => {
  const at = (a: Audio, sampleRate: number): Audio => ({ ...a, sampleRate });
  const shorter = (a: Audio, by: number): Audio =>
    ({ ...a, frames: a.frames - by, channels: a.channels.map((c) => c.slice(0, a.frames - by)) });

  it("a whole run at 44.1 kHz works: collected, levelled, written at 44.1 kHz, and it nulls", async () => {
    // Before, a 44.1 kHz first render was refused outright. This is the regression test for that.
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    for (let pass = 0; pass < 2; pass++) { exportNowAt(live, t.tempDir, 44100); await t.cmds.next(); }
    exportNowAt(live, t.tempDir, 44100);
    await t.cmds.finish();

    const done = t.messages.at(-1)!;
    expect(done.title).toBe("Stem Export: finished");
    expect(text(done)).toMatch(/Null test residual: -\d+\.\d dBFS/);
    const out = join(t.storageDir, "out", "Untitled Set");
    for (const n of ["Drums", "Keys - Played", "MASTER REFERENCE"]) {
      expect(readWav(join(out, `Untitled Set (${n}).wav`)).sampleRate).toBe(44100);   // written at the render's own rate
    }
  });

  it("the first render sets the rate: a 44.1 kHz first render is accepted, not refused", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNowAt(live, t.tempDir, 44100);
    await t.cmds.next();
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(1);
  });

  it("a first render at a rate it cannot measure is refused at once, naming the rate, and nothing moves", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    writeWav24(join(t.tempDir, "Untitled.wav"), at(TONES.Kick, 4000));
    await expect(t.cmds.next()).rejects.toThrow(/pass 1 of 4 \("Drums"\)[\s\S]*4000 Hz[\s\S]*cannot measure/);
    expect(existsSync(join(t.tempDir, "Untitled.wav"))).toBe(true);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(0);
  });

  it("every pass must use the same rate: a later render at another rate is refused, naming both", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNowAt(live, t.tempDir, 44100); await t.cmds.next();
    exportNow(live, t.tempDir);   // 48 kHz
    await expect(t.cmds.next()).rejects.toThrow(/pass 2 of 4 \("Keys - Played"\)[\s\S]*48000 Hz[\s\S]*"Drums" was 44100 Hz[\s\S]*same sample rate/);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(1);
    // Re-exporting over the same file at the right rate fixes it.
    exportNowAt(live, t.tempDir, 44100);
    await t.cmds.next();
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(2);
  });

  it("a render one sample shorter than the first is refused at once, naming the pass", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    writeWav24(join(t.tempDir, "Untitled.wav"), shorter(TONES.Bass, 1));
    await expect(t.cmds.next()).rejects.toThrow(/pass 2 of 4 \("Keys - Played"\)[\s\S]*47999 frames[\s\S]*"Drums" is 48000/);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(1);
    // Re-exporting over the same file fixes it; only that pass is redone.
    exportNow(live, t.tempDir);
    await t.cmds.next();
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))!.passIndex).toBe(2);
  });

  it("a render with a different channel count is refused", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    const mono: Audio = { ...TONES.Bass, channels: [TONES.Bass.channels[0]] };
    writeWav24(join(t.tempDir, "Untitled.wav"), mono);
    await expect(t.cmds.next()).rejects.toThrow(/1 channel\(s\), but "Drums" has 2/);
  });

  it("the last render is checked at Finish before the Set is touched", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    exportNow(live, t.tempDir); await t.cmds.next();
    exportNow(live, t.tempDir); await t.cmds.next();
    const mutes = live.mutes();
    writeWav24(join(t.tempDir, "Untitled.wav"), shorter(sumAudio([TONES.Kick, TONES.Bass]), 1));
    await expect(t.cmds.finish()).rejects.toThrow(/Master reference[\s\S]*frames/);
    expect(live.mutes()).toEqual(mutes);
    expect(runRecords(t.storageDir)).toHaveLength(1);
  });
});

describe("abort", () => {
  it("restores the Set exactly and removes the record", async () => {
    const live = fakeLive({ muted: ["Pad"] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(live.mutes()).not.toEqual({ Kick: false, Bass: false, Pad: true });
    await t.cmds.abort();
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: true });
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(t.messages.at(-1)!.title).toBe("Export aborted");
  });

  /** The author deleted Bass mid-run, so the record names a track the Set no longer has. */
  async function withDeletedBass(answers: string[]) {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    live.tracks.splice(1, 1);
    t.host.message = async (m: MessageSpec) => { t.messages.push(m); return answers.shift() ?? "ok"; };
    await t.cmds.abort();
    return { live, t };
  }

  it("Restore what matches: restores what it can, and says plainly what it could not", async () => {
    const { live, t } = await withDeletedBass(["restore", "keep"]);
    expect(t.messages.at(-2)!.title).toBe("This run does not match the open Set");
    const m = t.messages.at(-1)!;
    expect(m.title).toBe("Restored what could be found");
    expect(text(m)).toMatch(/put back[\s\S]*could NOT be restored[\s\S]*Bass/);
    expect(m.buttons!.map((b) => b.id)).toEqual(["discard", "keep"]);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))).not.toBeNull();   // kept on request
    expect(live.mutes()).toEqual({ Kick: false, Pad: false });
  });

  it("Restore what matches, then discard: the final message does not claim Live was untouched", async () => {
    const { t } = await withDeletedBass(["restore", "discard"]);
    expect(runRecords(t.storageDir)).toEqual([]);
    const done = t.messages.at(-1)!;
    expect(done.title).toBe("Run record discarded");
    const body = text(done);
    expect(body).not.toMatch(/not touched/i);
    expect(body).toMatch(/could be found were restored[\s\S]*Bass/);
  });

  it("discarding a mismatched record without restoring says Live was not touched", async () => {
    const { t } = await withDeletedBass(["discard"]);
    expect(text(t.messages.at(-1)!)).toMatch(/Live was not touched/);
  });

  it("a successful Abort names the song the record came from", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: () => ({ ...DRUMS_BASS(), song: "Learning to Feel" }) });
    await t.cmds.configure();
    await t.cmds.abort();
    expect(text(t.messages.at(-1)!)).toContain('"Learning to Feel"');
  });
});

describe("collecting renders", () => {
  const state = (): RunState => ({
    song: "S", passIndex: 0, collected: {},
    passes: [{ kind: "stem", name: "Drums", include: [], exclude: [], outputName: "S (Drums).wav" }],
    author: { mutes: {}, solos: {}, returnSolos: {}, masterEnabled: {} },
  });

  it("only counts finished audio files at the top level", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "a.wav"), TONES.Kick);
    writeFileSync(join(dir, "empty.wav"), "");
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, ".hidden.wav"), "x");
    mkdirSync(join(dir, "collected"));
    expect(pendingRenders(dir)).toEqual([join(dir, "a.wav")]);
    expect(Object.keys(snapshotTemp(dir))).toEqual([join(dir, "a.wav")]);
  });

  it("treats a file rewritten after the baseline as new, and an untouched one as old", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "Untitled.wav"), TONES.Kick);
    const baseline = snapshotTemp(dir);
    expect(pendingRenders(dir, baseline)).toEqual([]);
    const later = { [join(dir, "Untitled.wav")]: baseline[join(dir, "Untitled.wav")] - 1000 };
    expect(pendingRenders(dir, later)).toEqual([join(dir, "Untitled.wav")]);
  });

  const instant: Settle = { quietMs: 0, settleMs: 0, sleep: async () => {}, now: () => Date.now() };

  it("moves the claimed render out of the export folder and is idempotent for that pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "Untitled.wav"), TONES.Kick);
    const s = await collectRender(state(), dir, instant);
    expect(existsSync(join(dir, "Untitled.wav"))).toBe(false);
    expect(existsSync(s.collected.Drums)).toBe(true);
    expect(await collectRender(s, dir, instant)).toBe(s);   // no second render needed
  });

  it("refuses a file written moments ago (Live may still be writing it) and moves nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "Untitled.wav"), TONES.Kick);
    await expect(collectRender(state(), dir, { ...instant, quietMs: 60_000 })).rejects.toThrow(/Export still running/);
    expect(existsSync(join(dir, "Untitled.wav"))).toBe(true);
  });

  it("refuses a file that is still growing, even if its mtime is old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    const f = join(dir, "Untitled.wav");
    writeWav24(f, TONES.Kick);
    const growing: Settle = { ...instant, settleMs: 1000, sleep: async () => { writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.alloc(64)])); } };
    await expect(collectRender(state(), dir, growing)).rejects.toThrow(/Export still running/);
    expect(existsSync(f)).toBe(true);
  });

  it("claims a file that has sat untouched for the quiet period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "Untitled.wav"), TONES.Kick);
    const later = { ...instant, quietMs: 2000, now: () => Date.now() + 5000 };
    const s = await collectRender(state(), dir, later);
    expect(existsSync(s.collected.Drums)).toBe(true);
  });
});

describe("manifestFromResponse", () => {
  it("groups assignments by stem, keeps Backing computed, carries suffixes and targets", () => {
    const base = { ...emptyManifest("S"), targetLufs: -16 };
    base.stems.Drums = { trackKeys: ["old"], suffix: " - Played" };
    const m = manifestFromResponse(base, {
      cancelled: false, assignments: { Kick: "Drums", Snare: "Drums", Bass: "Keys - Played", Pad: "Backing" },
      extras: [{ name: "Vox", trackKeys: ["V"] }],
    }, "S");
    expect(m.stems.Drums).toEqual({ trackKeys: ["Kick", "Snare"], suffix: " - Played" });
    expect(m.stems["Keys - Played"]).toEqual({ trackKeys: ["Bass"] });
    expect(m.stems.Backing).toEqual({ trackKeys: [], computed: true });
    expect(m.targetLufs).toBe(-16);
    expect(m.extras).toEqual([{ name: "Vox", trackKeys: ["V"] }]);
  });
});
