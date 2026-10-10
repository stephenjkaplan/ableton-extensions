import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, sumAudio, writeWav24, type Audio } from "../src/audio.js";
import {
  Commands, collectRender, manifestFromResponse, pendingRenders, readSongName, requestFor, snapshotTemp,
  songNameFile, type Host,
} from "../src/commands.js";
import { registerAll } from "../src/extension.js";
import { emptyManifest, manifestPath } from "../src/manifest.js";
import { loadRunState, runStatePath, saveRunState, type LiveBridge, type RunState } from "../src/run.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import type { MessageSpec } from "../src/ui/message.js";
import type { MappingRequest } from "../src/ui/protocol.js";

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

function fakeLive(opts: { muted?: string[]; soloed?: string[]; master?: { name: string; on: boolean }[] } = {}) {
  const tracks: FakeTrack[] = ["Kick", "Bass", "Pad"].map((name) => ({
    name, mute: opts.muted?.includes(name) ?? false, solo: opts.soloed?.includes(name) ?? false,
    groupTrack: null, devices: [],
  }));
  const master = (opts.master ?? [{ name: "Limiter", on: false }]).map((d) => ({ ...d }));
  let inTx = false;
  const bridge: LiveBridge = {
    tracks: async () => tracks.map((t) => ({
      key: t.name,
      getMute: () => t.mute, setMute: (v: boolean) => { if (!inTx) throw new Error("outside tx"); t.mute = v; },
      getSolo: () => t.solo, setSolo: (v: boolean) => { if (!inTx) throw new Error("outside tx"); t.solo = v; },
    })),
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
  mapping?: (req: MappingRequest) => unknown;
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
      return JSON.stringify(script.mapping ? script.mapping(req) : { cancelled: true });
    },
    message: async (m) => { messages.push(m); return answers.shift() ?? (m.buttons?.[0]?.id ?? "ok"); },
  };
  return { host, storageDir, tempDir, messages, requests, cmds: new Commands(host) };
}

const DRUMS_BASS = () => ({
  cancelled: false, assignments: { Kick: "Drums", Bass: "Keys - Played" }, extras: [],
});
const text = (m: MessageSpec) => `${m.title}\n${m.lines.join("\n")}`;

/** "Export" in the fake Live: renders whatever is unmuted into the export folder, always as Untitled.wav. */
function exportNow(live: ReturnType<typeof fakeLive>, tempDir: string) {
  const heard = live.tracks.filter((t) => !t.mute && !t.solo || t.solo).map((t) => TONES[t.name]);
  writeWav24(join(tempDir, "Untitled.wav"), sumAudio(heard));
}

describe("song name", () => {
  it("is the default until song-name.txt says otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-sn-"));
    expect(readSongName(dir)).toEqual({ name: "Untitled Set", isDefault: true });
    writeFileSync(songNameFile(dir), "  Surrounded by Giants \nsecond line ignored\n");
    expect(readSongName(dir)).toEqual({ name: "Surrounded by Giants", isDefault: false });
    writeFileSync(songNameFile(dir), "\n");
    expect(readSongName(dir).isDefault).toBe(true);
  });
});

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
      mapping: () => ({ cancelled: false, assignments: { Kick: "Drums", Ghost: "Drums" }, extras: [] }),
    });
    await t.cmds.configure();
    expect(existsSync(runStatePath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(existsSync(manifestPath(t.storageDir, "Untitled Set"))).toBe(false);
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });
    expect(text(t.messages.at(-1)!)).toMatch(/Cannot start the export[\s\S]*Ghost/);
  });

  it("BLOCKS when the Master has an enabled device, even if the dialog was submitted", async () => {
    const live = fakeLive({ master: [{ name: "Limiter", on: true }] });
    const t = makeHost(live, { mapping: DRUMS_BASS });
    await t.cmds.configure();
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))).toBeNull();
    expect(live.master[0].on).toBe(true);
    expect(text(t.messages.at(-1)!)).toContain("Limiter");
  });

  it("sends EFFECTIVE mutedness (children of a muted group) from the snapshot, not the raw flag", () => {
    const grp: TrackLike = { name: "Old", mute: true, groupTrack: null, devices: [] };
    const kid: TrackLike = { name: "Kid", mute: false, groupTrack: grp, devices: [] };
    const snap = snapshotSong({ tracks: [grp, kid], mainTrack: { name: "M", mute: false, groupTrack: null, devices: [] } }, "S");
    const req = requestFor(snap, emptyManifest("S"), "/t", []);
    expect(req.tracks.map((x) => [x.key, x.muted, x.depth])).toEqual([["Old", true, 0], ["Old/Kid", true, 1]]);
  });

  it("shows the default-song-name note in the dialog's findings", async () => {
    const t = makeHost(fakeLive());
    await t.cmds.configure();
    expect(t.requests[0].findings.some((f) => f.rule === "song-name-default" && f.detail.includes("song-name.txt"))).toBe(true);
  });

  it("seeds the dialog from the saved manifest on the next run", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["ok", "restart"] });
    await t.cmds.configure();
    await t.cmds.abort();
    await t.cmds.configure();
    expect(t.requests[1].current.assignments).toEqual({ Kick: "Drums", Bass: "Keys - Played" });
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

  /** A record for a DIFFERENT song at this song's path (safeName maps "A/B" and "A_B" together). */
  function otherSongRecord(t: ReturnType<typeof makeHost>) {
    writeFileSync(songNameFile(t.storageDir), "A_B\n");
    const s: RunState = {
      song: "A/B", passIndex: 1, passes: [], collected: {},
      author: { mutes: { Kick: true }, solos: {}, returnSolos: {}, masterEnabled: {} },
    };
    saveRunState(s, runStatePath(t.storageDir, "A_B"));
    return runStatePath(t.storageDir, "A_B");
  }

  it("different song: says so, touches nothing, and offers to discard", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["cancel"] });
    const path = otherSongRecord(t);
    await t.cmds.configure();
    const m = t.messages[0];
    expect(m.title).toMatch(/another song/);
    expect(m.buttons!.map((b) => b.id)).toEqual(["discard", "cancel"]);
    expect(existsSync(path)).toBe(true);          // declined: kept
    expect(live.mutes()).toEqual({ Kick: false, Bass: false, Pad: false });   // Kick NOT muted from the foreign record
    expect(t.requests).toHaveLength(0);
  });

  it("different song, discard: the record goes, Live is untouched, and configure proceeds", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["discard"] });
    const path = otherSongRecord(t);
    await t.cmds.configure();
    expect(t.requests).toHaveLength(1);
    expect(loadRunState(path)!.song).toBe("A_B");   // the new run replaced the discarded record
  });

  it("a corrupt record can be discarded", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["discard"] });
    const path = runStatePath(t.storageDir, "Untitled Set");
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

  it("when the Set cannot be restored, keeps the record and offers discard", async () => {
    const live = fakeLive();
    const t = makeHost(live, { mapping: DRUMS_BASS, buttons: ["ok", "keep"] });
    await t.cmds.configure();
    live.tracks.splice(1, 1);   // the author deleted Bass mid-run
    await t.cmds.abort();
    const m = t.messages.at(-1)!;
    expect(m.title).toBe("Could not fully restore your Set");
    expect(m.buttons!.map((b) => b.id)).toEqual(["keep", "discard"]);
    expect(loadRunState(runStatePath(t.storageDir, "Untitled Set"))).not.toBeNull();
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

  it("moves the claimed render out of the export folder and is idempotent for that pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-c-"));
    writeWav24(join(dir, "Untitled.wav"), TONES.Kick);
    const s = collectRender(state(), dir);
    expect(existsSync(join(dir, "Untitled.wav"))).toBe(false);
    expect(existsSync(s.collected.Drums)).toBe(true);
    expect(collectRender(s, dir)).toBe(s);   // no second render needed
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
