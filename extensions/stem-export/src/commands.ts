// The four commands. SDK-free: everything impure arrives through `Host` (see live.ts), so the whole
// flow is testable with a fake Live.
//
// The loop is MANUAL: Configure applies pass 1, and you run Next after each Export. Nothing here
// watches the export folder. `Commands.next` is a plain method, so a future watcher can call it
// when a render lands without restructuring anything; whether a watcher would stay alive in Live is
// unproven (docs/superpowers/notes/lifecycle-spike.md has not been run), so none is implemented.
//
// Every command re-reads its state from disk (the run-state file), so nothing depends on this module
// staying resident between commands.
import {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { isSupportedSampleRate, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, readWav, type Audio } from "./audio.js";
import { DEFAULT_REGISTRY } from "./default-registry.js";
import {
  emptyManifest, loadManifest, manifestPath, readSaved, resolve, safeName, saveManifest,
  type Manifest,
} from "./manifest.js";
import { assignmentsOf, check, manifestFromResponse, matchManifests, namedKeys, pruneStale } from "./mapping-core.js";
import { buildPlan } from "./plan.js";
import { stemNames } from "./registry.js";
import {
  advance, applyPass, beginRun, clearRunState, discardRunState, finalize, isStemRender, loadRunState,
  recoverRun, restoreAuthorState, runStatePath, saveRunState,
  type LiveBridge, type RunState, type StemScore,
} from "./run.js";
import { snapshotToData, type SongSnapshot } from "./snapshot.js";
import { OK, type MessageSpec } from "./ui/message.js";
import { encodeRequest, parseResponse, type MappingRequest } from "./ui/protocol.js";
import { blocking, type Finding, type KeyTap } from "./validate.js";

export interface Host {
  storageDir: string;
  tempDir: string;
  snapshot(song: string): Promise<SongSnapshot>;
  bridge(snapshot: SongSnapshot): LiveBridge;
  /** Sidechain tap points. Always empty today: the SDK exposes none (see live.ts). */
  taps(): readonly KeyTap[];
  /** Opens the mapping dialog on a data: URL and resolves with the page's reply (raw JSON). */
  showMapping(url: string): Promise<string>;
  /** Shows a modal message and resolves with the id of the button pressed. */
  message(m: MessageSpec): Promise<string>;
  /** How long a render must sit untouched before it counts as finished. Tests shorten it. */
  settle?: Settle;
}

/** A render is only claimed once Live has stopped writing it. */
export interface Settle {
  /** The file's mtime must be at least this old. */
  quietMs: number;
  /** Then its size and mtime must be unchanged across a wait of this long. */
  settleMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export const DEFAULT_SETTLE: Settle = {
  quietMs: 2000, settleMs: 1000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
};

// ------------------------------------------------------------------ song name

export const DEFAULT_SONG = "Untitled Set";
// The SDK exposes no Set name or path, so the song name cannot be read from Live. `configure` recognises
// the open Set by which saved mapping matches its tracks, and the user confirms the name in the dialog.
// Nothing looks a run up by name either: an active run is found by scanning `runs/`, and carries its own.

// ------------------------------------------------------------ manifest <-> dialog

// The pure helpers live in mapping-core.ts (bundled into the dialog page too); re-exported for callers.
export { assignmentsOf, check, manifestFromResponse };

/** The stale-keys note names this many keys, then "and N more", so a heavily renamed Set cannot make it huge. */
export const STALE_KEYS_SHOWN = 8;

export function requestFor(
  snap: SongSnapshot, m: Manifest, tempDir: string, taps: readonly KeyTap[], extraFindings: Finding[] = [],
): MappingRequest {
  let outputPreview: MappingRequest["outputPreview"] = [];
  try {
    outputPreview = buildPlan(snap, m, resolve(m, snap))
      .filter((p) => p.kind === "stem")
      .map((p) => ({ stem: p.name, count: p.include.length, filename: p.outputName }));
  } catch { /* no preview: the dialog falls back to "<song> (<stem>).wav" for every row */ }
  // The dialog does NOT recompute filenames: it reuses these (following only the song name). Known and acceptable:
  // a stem with a suffix that gets its first track inside the dialog has no seed entry, so it previews without the suffix.
  return {
    song: snap.song,
    tempDirectory: tempDir,
    stemNames: [...stemNames(DEFAULT_REGISTRY)],
    current: { assignments: assignmentsOf(m), extras: m.extras.map((e) => ({ name: e.name, trackKeys: [...e.trackKeys] })) },
    snapshot: snapshotToData(snap),
    base: m,
    taps: taps.map((t) => ({ ...t })),
    notes: extraFindings,
    outputPreview,
  };
}

// ------------------------------------------------------------- render collection

/** Audio files at the top level of the export folder, with their mtimes. Subfolders are ignored. */
export function snapshotTemp(tempDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(tempDir)) return out;
  for (const name of readdirSync(tempDir)) {
    const p = join(tempDir, name);
    if (isStemRender(p) && existsSync(p)) out[p] = statSync(p).mtimeMs;
  }
  return out;
}

/** Finished renders in the export folder that appeared (or changed) since the run began. */
export function pendingRenders(tempDir: string, baseline: Record<string, number> = {}): string[] {
  return Object.entries(snapshotTemp(tempDir))
    .filter(([p, mtime]) => !(p in baseline) || mtime > baseline[p])
    .map(([p]) => p)
    .sort();
}

const STILL_RUNNING = "Export still running: wait for Live to finish writing the file, then try again.";

/** Throws unless Live has stopped writing `file`: old enough, and unchanged across a short wait. */
async function assertSettled(file: string, settle: Settle): Promise<void> {
  const a = statSync(file);
  if (settle.quietMs > 0 && settle.now() - a.mtimeMs < settle.quietMs) throw new Error(STILL_RUNNING);
  await settle.sleep(settle.settleMs);
  const b = statSync(file);
  if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) throw new Error(STILL_RUNNING);
}

/**
 * Claims the one new render in the export folder for the CURRENT pass: moves it into
 * `<temp>/collected/<song>/` (so re-using one filename for every export is safe) and records it.
 * Idempotent if the current pass was already collected. Throws, changing nothing, on zero or
 * several candidates, or while Live is still writing the file. Returns the updated state; the
 * caller persists it.
 */
export async function collectRender(
  s: RunState, tempDir: string, settle: Settle = DEFAULT_SETTLE,
): Promise<RunState> {
  const pass = s.passes[s.passIndex];
  if (!pass) throw new Error(`No pass at index ${s.passIndex}`);
  const have = s.collected[pass.name];
  if (have !== undefined && existsSync(have)) return s;

  const found = pendingRenders(tempDir, s.tempBaseline);
  if (found.length === 0) {
    throw new Error(
      `No new render found in ${tempDir}. Export "${pass.name}" with Live's export destination set to ` +
      `that folder, wait for it to finish, then try again.`);
  }
  if (found.length > 1) {
    throw new Error(
      `More than one new audio file is in ${tempDir}, so it is unclear which is "${pass.name}": ` +
      `${found.map((f) => f.slice(tempDir.length + 1)).join(", ")}. Remove the extras and try again.`);
  }
  await assertSettled(found[0], settle);
  assertUsable(s, pass.name, found[0]);
  const dir = collectedDir(tempDir, s.song);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${s.passIndex + 1} - ${safeName(pass.name)}${extname(found[0]).toLowerCase()}`);
  renameSync(found[0], dest);
  return { ...s, collected: { ...s.collected, [pass.name]: dest } };
}

/**
 * Reads the render now and checks it can be used, so a bad pass is caught at the pass that caused it
 * rather than at Finish, where one bad render would discard all of them. Any sample rate in the
 * supported range is accepted (the first render sets it), and every later render must match the first
 * collected one in sample rate, channel count and length. Throws, leaving the file where it is
 * (re-export over it, or delete it).
 */
function assertUsable(s: RunState, passName: string, file: string): void {
  const n = s.passIndex + 1;
  const bad = (why: string): never => {
    throw new Error(`The render for pass ${n} of ${s.passes.length} ("${passName}") ${why} ` +
      `Delete it and export that pass again; nothing was collected.`);
  };
  let a: Audio;
  try { a = readWav(file); } catch (e) { return bad(`cannot be read: ${(e as Error).message}.`); }

  const refPass = s.passes.find((p) => {
    const f = s.collected[p.name];
    return p.name !== passName && f !== undefined && existsSync(f);
  });
  if (!refPass) {
    if (!isSupportedSampleRate(a.sampleRate)) {
      bad(`is ${a.sampleRate} Hz, which stem export cannot measure (it supports whole sample rates from ` +
          `${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz).`);
    }
    return;
  }
  const ref = readWav(s.collected[refPass.name]);
  if (a.sampleRate !== ref.sampleRate) {
    bad(`is ${a.sampleRate} Hz, but "${refPass.name}" was ${ref.sampleRate} Hz. ` +
        `Every pass must use the same sample rate.`);
  }
  if (a.channels.length !== ref.channels.length) {
    bad(`has ${a.channels.length} channel(s), but "${refPass.name}" has ${ref.channels.length}.`);
  }
  if (a.frames !== ref.frames) {
    bad(`is ${a.frames} frames long, but "${refPass.name}" is ${ref.frames} (${a.frames - ref.frames > 0 ? "+" : ""}${a.frames - ref.frames}). ` +
        `Every export must cover exactly the same range: check the arrangement selection.`);
  }
}

const collectedDir = (tempDir: string, song: string) => join(tempDir, "collected", safeName(song));
/** The collected 24-bit renders are large; they live in temp only for the length of a run. */
const cleanCollected = (tempDir: string, song: string) =>
  rmSync(collectedDir(tempDir, song), { recursive: true, force: true });

// ------------------------------------------------------------ run records

/** One file in `runs/`. `state` is null when the file could not be read; `error` says why. */
export interface RunRecord { path: string; state: RunState | null; error?: string }

/**
 * Every run record on disk, found by SCANNING `runs/`, never by the current song name: the name is
 * user-editable, and a run must stay reachable (abort/finish/next) whatever it is set to now.
 */
export function runRecords(storageDir: string): RunRecord[] {
  const dir = dirname(runStatePath(storageDir, "x"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => {
    const path = join(dir, n);
    try {
      return { path, state: loadRunState(path) };
    } catch (e) {
      return { path, state: null, error: (e as Error).message };
    }
  }).filter((r) => r.state !== null || r.error !== undefined);
}

// ------------------------------------------------------------------ commands

const CANCEL = { id: "cancel", label: "Cancel" };
const DISCARD = { id: "discard", label: "Discard the record" };

const describePass = (s: RunState) => {
  const p = s.passes[s.passIndex];
  return `Pass ${s.passIndex + 1} of ${s.passes.length}: ${p.name}`;
};

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const andList = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * The top of the results dialog when the null test failed: how many stems match, then each one that
 * does not, with its score and where it is worst. Empty when there are no scores.
 */
export function stemScoreLines(scores: readonly StemScore[]): string[] {
  if (scores.length === 0) return [];
  const off = scores.filter((s) => !s.matches);
  if (off.length === 0) {
    return ["The leftover isn't in any one stem. Check for a group split across stems or something on a return track."];
  }
  return [
    `${scores.length - off.length} of ${scores.length} stems match.`,
    ...off.map((s) => {
      const where = s.offRanges.map((r) => `${clock(Math.floor(r.start))}–${clock(Math.ceil(r.end))}`);
      return `${s.name}: ${s.score!.toFixed(2)}` + (where.length ? ` · worst around ${andList(where)}` : "");
    }),
    `Usually a device that renders differently each time (Transmute, AutoShift, live Serum, Echo noise) or a ` +
      `sidechain that listens after another stem's mute. Listen to ${off.length === 1 ? "that stem" : "those stems"} at those times.`,
  ];
}

export class Commands {
  constructor(readonly host: Host) {}

  private get settle() { return this.host.settle ?? DEFAULT_SETTLE; }
  private say(title: string, ...lines: string[]) { return this.host.message({ title, lines }); }
  private async bridgeFor(song: string) { return this.host.bridge(await this.host.snapshot(song)); }

  /**
   * The single active run, for next/finish. Says so and returns null when there is none, when a
   * record is unreadable, or when several exist (Abort clears them one at a time).
   */
  private async activeRun(): Promise<{ path: string; state: RunState } | null> {
    const recs = runRecords(this.host.storageDir);
    if (recs.length === 0) { await this.say("No export in progress", "Run Stem Export first."); return null; }
    if (recs.length > 1 || !recs[0].state) {
      await this.say("Cannot tell which run to use",
        recs.length > 1 ? `There are ${recs.length} unfinished run records.` : `The run record cannot be read: ${recs[0].error}`,
        `Run "Stem Export: Abort" to put your Set back and clear them.`);
      return null;
    }
    return { path: recs[0].path, state: recs[0].state };
  }

  /** Rolls back and forgets a run whose first pass could not be applied. Never throws. */
  private async rollBack(bridge: LiveBridge, s: RunState, statePath: string): Promise<string> {
    try {
      await restoreAuthorState(bridge, s);
      clearRunState(statePath);
      return "Your Set was restored.";
    } catch (e) {
      return `Your Set could NOT be fully restored (${(e as Error).message}). Run Stem Export: Abort.`;
    }
  }

  /**
   * Puts the Set back from a record and deletes it. `outcome` is "restored" or "discarded" when the
   * record is gone, "kept" when the user declined or it could not be removed. Never destroys a
   * record it could not restore without being asked: unreadable, mismatched or failing records all
   * offer an explicit discard. `note` says, accurately, what happened to Live when it is not simply
   * "everything was put back".
   */
  private async resolveRecord(rec: RunRecord): Promise<{ outcome: "restored" | "discarded" | "kept"; note?: string }> {
    const kept = { outcome: "kept" as const };
    if (!rec.state) {
      const a = await this.host.message({
        title: "Unreadable run record",
        lines: [`${rec.error}`, `Discarding deletes only the record; Live is not touched, so check your mutes and Master devices yourself.`, rec.path],
        buttons: [DISCARD, CANCEL],
      });
      if (a !== DISCARD.id) return kept;
      discardRunState(rec.path);
      return { outcome: "discarded", note: "Live was not touched; check your mutes and Master devices yourself." };
    }
    const state = rec.state;
    const bridge = await this.bridgeFor(state.song);

    // The record is matched to the Set by its tracks, not by any name.
    const live = new Set((await bridge.tracks()).map((t) => t.key));
    const absent = Object.keys(state.author.mutes).filter((k) => !live.has(k));
    let partial = false;
    if (absent.length) {
      const a = await this.host.message({
        title: "This run does not match the open Set",
        lines: [`The unfinished run for "${state.song}" recorded ${absent.length} track${absent.length === 1 ? "" : "s"} that ` +
          `${absent.length === 1 ? "is" : "are"} not in this Set: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", ..." : ""}.`,
          `Either a track was renamed or deleted, or this is a different Set. "Restore what matches" puts back every recorded ` +
          `track, solo and Master device it can find in this Set and reports the rest; discarding deletes only the record (Live is NOT touched).`],
        buttons: [{ id: "restore", label: "Restore what matches" }, DISCARD, CANCEL],
      });
      if (a === DISCARD.id) {
        discardRunState(rec.path);
        cleanCollected(this.host.tempDir, state.song);
        return { outcome: "discarded", note: "Live was not touched; check your mutes and Master devices yourself." };
      }
      if (a !== "restore") return kept;
      partial = true;
    }
    try {
      const r = await recoverRun(bridge, rec.path, state.song);
      if (r.status === "different-song") throw new Error(`The record belongs to "${r.state.song}".`); // cannot happen: we pass its own name
      cleanCollected(this.host.tempDir, state.song);
      return { outcome: "restored", note: `Restored from the unfinished run for "${state.song}".` };
    } catch (e) {
      const detail = (e as Error).message.replace(/^Could not fully restore author state: /, "");
      const a = await this.host.message({
        title: partial ? "Restored what could be found" : "Could not fully restore your Set",
        lines: [partial
            ? `Every recorded item that exists in this Set was put back. These could NOT be restored: ${detail}`
            : `Some items were put back and some could not be: ${detail}`,
          `You can discard the record, or keep it (for example to restore a renamed track and try again). ` +
          `Either way, check the items above by hand.`],
        buttons: [DISCARD, { id: "keep", label: "Keep the record" }],
      });
      if (a !== DISCARD.id) return kept;
      discardRunState(rec.path);
      cleanCollected(this.host.tempDir, state.song);
      return { outcome: "discarded", note: `Items that could be found were restored. Not restored: ${detail}` };
    }
  }

  /**
   * Every readable saved mapping, for matching against the open Set. A file that cannot be read or
   * is not a usable manifest is skipped: it must never stop the dialog opening.
   */
  private savedManifests(): { name: string; manifest: Manifest; mtimeMs: number }[] {
    const dir = dirname(manifestPath(this.host.storageDir, "x"));
    if (!existsSync(dir)) return [];
    const out: { name: string; manifest: Manifest; mtimeMs: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const path = join(dir, f);
      const r = readSaved(path);
      if (r.kind !== "ok") continue;
      try { out.push({ name: r.manifest.song, manifest: r.manifest, mtimeMs: statSync(path).mtimeMs }); } catch { /* skipped */ }
    }
    return out;
  }

  async configure(): Promise<void> {
    const { storageDir, tempDir } = this.host;

    // Any record left behind means the Set may still be mutated: deal with it before capturing
    // anything, whatever song name it was filed under.
    for (let rec = runRecords(storageDir)[0]; rec; rec = runRecords(storageDir)[0]) {
      if (rec.state) {
        const go = await this.host.message({
          title: "A run is already in progress",
          lines: [`"${rec.state.song}", ${describePass(rec.state)}. Starting again first restores your mutes, solos and ` +
            `Master devices, and forgets the renders collected so far.`],
          buttons: [{ id: "restart", label: "Restore and start over" }, CANCEL],
        });
        if (go !== "restart") return;
      }
      if ((await this.resolveRecord(rec)).outcome === "kept") return;
    }

    // Live gives no Set name, so the open Set is recognised by its tracks: the saved mapping that
    // matches them seeds the dialog. With no match the dialog opens as a new, unnamed song.
    const snap0 = await this.host.snapshot(DEFAULT_SONG);   // taken AFTER any restore: the author's own state
    const match = matchManifests(this.savedManifests(), snap0);
    let seedName = match ? match.name : DEFAULT_SONG;
    let seed: Manifest = match ? match.manifest : emptyManifest(DEFAULT_SONG);
    let intro: Finding[] = match ? [{
      severity: "info", rule: "loaded-saved-mapping", title: "Loaded a saved mapping",
      detail: `Loaded the saved mapping for '${match.name}': ${match.matched} of its ${match.total} tracks are in this Set. ` +
        `If this is a different song, type its name.`,
    }] : [{
      severity: "info", rule: "song-name-default", title: "Set the song name",
      detail: `Live does not tell extensions the Set's name. Type it in the Song field; it names every file and the output folder.`,
    }];
    const asked = new Set<string>();   // a name is asked about at most once, so Load it cannot loop

    let base: Manifest;
    let resp;
    for (;;) {
      // Saved assignments that name a track no longer in the Set are dropped before the dialog opens, so
      // the dialog (and the manifest saved from it) never carries them. The user is told once, as a note.
      const pruned = pruneStale(seed, { ...snap0, song: seedName });
      base = pruned.manifest;
      const dropped = pruned.dropped;
      const note: Finding[] = [...intro];
      if (dropped.length) {
        const n = dropped.length;
        const shown = dropped.slice(0, STALE_KEYS_SHOWN).join(", ") +
          (n > STALE_KEYS_SHOWN ? `, and ${n - STALE_KEYS_SHOWN} more` : "");
        note.push({
          severity: "info", rule: "stale-keys", title: "Saved assignments not shown",
          detail: `${n} saved assignment${n === 1 ? "" : "s"} no longer match${n === 1 ? "es" : ""} a track ` +
            `and ${n === 1 ? "is" : "are"} not shown (${shown}); ${n === 1 ? "it is" : "they are"} removed from ` +
            `the saved mapping when you continue.`,
        });
      }
      const req = requestFor({ ...snap0, song: seedName }, base, tempDir, this.host.taps(), note);

      resp = parseResponse(await this.host.showMapping("data:text/html," + encodeRequest(req)));
      if (resp.cancelled) return;

      // Typing a name that already has a saved mapping would, on Continue, overwrite it with whatever the
      // dialog now holds (and the dialog was not seeded from it). Ask first, once per name. A file that
      // exists but cannot be used is treated as existing: it would be replaced, so the user is told.
      const found = resp.song !== seedName && !asked.has(resp.song)
        ? readSaved(manifestPath(storageDir, resp.song)) : { kind: "none" as const };
      if (found.kind === "none") break;
      asked.add(resp.song);
      let answer: string;
      if (found.kind === "ok") {
        const n = namedKeys(found.manifest).size;
        answer = await this.host.message({
          title: "A saved mapping already exists",
          lines: [`'${resp.song}' already has a saved mapping that names ${n} track${n === 1 ? "" : "s"}.`,
            `Live does not tell extensions which Set is open, so this may be this Set's mapping from an earlier session, ` +
            `or another song's. Load it to start the dialog from that mapping. Replace it overwrites that mapping's ` +
            `saved assignments with what you just set; its loudness target and stem suffixes are kept.`],
          buttons: [{ id: "load", label: "Load it" }, { id: "replace", label: "Replace it" }, CANCEL],
        });
        if (answer === "load") { seedName = resp.song; seed = found.manifest; intro = []; continue; }
      } else {
        answer = await this.host.message({
          title: "A saved mapping exists but cannot be read",
          lines: [`'${resp.song}' already has a saved mapping file, but it cannot be read, so it cannot be loaded. ` +
            `It will be replaced if you continue.`],
          buttons: [{ id: "replace", label: "Replace it" }, CANCEL],
        });
      }
      if (answer !== "replace") return;
      break;
    }

    const song = resp.song;
    // A usable manifest already saved under the confirmed name wins over the seed's, so renaming does not
    // discard that song's LUFS target and stem suffixes.
    const saved = song === seedName ? null : readSaved(manifestPath(storageDir, song));
    const named = saved?.kind === "ok" ? saved.manifest : base;
    const manifest = manifestFromResponse(named, resp, song);
    // Saved before validating: it is the extension's own storage, the Set is untouched, and a 70-row
    // mapping must survive one fixable error.
    saveManifest(manifest, manifestPath(storageDir, song));
    // Save & close: a draft. The Set is untouched; the next Stem Export reopens the dialog from it.
    if (resp.saveOnly) return;

    // Never trust the dialog's displayed findings: re-validate, against the Set as it is now.
    const fresh = await this.host.snapshot(song);
    const { resolution, findings } = check(fresh, manifest, this.host.taps());
    const errors = blocking(findings);
    if (errors.length) {
      await this.say("Cannot start the export",
        ...errors.map((f) => `${f.title}: ${f.detail}`),
        "Nothing was changed in your Set. Your mapping was saved; fix the above and run Stem Export again.");
      return;
    }

    const passes = buildPlan(fresh, manifest, resolution);
    const statePath = runStatePath(storageDir, song);
    const freshBridge = this.host.bridge(fresh);
    const state = await beginRun(freshBridge, passes, song, statePath);
    const started: RunState = { ...state, tempBaseline: snapshotTemp(tempDir) };
    try {
      saveRunState(started, statePath);
      await applyPass(freshBridge, started);
    } catch (e) {
      const restored = await this.rollBack(freshBridge, started, statePath);
      throw new Error(`Could not set up the first pass: ${(e as Error).message} ${restored}`);
    }
    const warnings = findings.filter((f) => f.severity === "warn");
    await this.say(`Stem Export: ${describePass(started)}`,
      `Set Live's export destination to this folder (once), then Export Audio/Video as WAV, at the same sample rate for every pass. Keep ` +
      `anything else out of that folder:`,
      tempDir,
      `Any file name will do. When it has finished, run "Stem Export: Next Pass".`,
      // After the export instructions and the folder path, so a few warnings cannot push the path out of view.
      ...(warnings.length
        ? [`Warnings (the run goes ahead):`, ...warnings.map((f) => `${f.title}: ${f.detail}`)]
        : []),
      `The finished stems will be written to ${join(storageDir, "out", safeName(song))}`);
  }

  /** Collects the render for the current pass, then moves to and applies the next. */
  async next(): Promise<void> {
    const run = await this.activeRun();
    if (!run) return;
    const { state, path } = run;
    if (state.passIndex + 1 >= state.passes.length) {
      return void (await this.say("That was the last pass",
        `Run "Stem Export: Finish" to level and write the stems.`));
    }

    const collected = await collectRender(state, this.host.tempDir, this.settle);
    const moved = advance(collected);
    saveRunState(moved, path);   // persisted before touching Live, like beginRun does

    const bridge = await this.bridgeFor(state.song);
    try {
      await applyPass(bridge, moved);
    } catch (e) {
      throw new Error(`${describePass(moved)} could not be applied: ${(e as Error).message} ` +
        `Run Stem Export: Abort to restore your Set.`);
    }
    await this.say(`Stem Export: ${describePass(moved)}`,
      `Export Audio/Video to ${this.host.tempDir}, wait for it to finish, then run ` +
      (moved.passIndex + 1 >= moved.passes.length ? `"Stem Export: Finish".` : `"Stem Export: Next Pass".`));
  }

  async finish(): Promise<void> {
    const { storageDir, tempDir } = this.host;
    const run = await this.activeRun();
    if (!run) return;
    const { path } = run;

    // Everything must be in hand BEFORE the Set is touched, so a premature Finish changes nothing.
    const state = await collectRender(run.state, tempDir, this.settle);
    saveRunState(state, path);
    const song = state.song;   // the name the run began under, not whatever is prefilled now
    const missing = state.passes.filter((p) => state.collected[p.name] === undefined).map((p) => p.name);
    if (missing.length) {
      return void (await this.say("Not every pass has been exported",
        `Still missing: ${missing.join(", ")}.`,
        `Use "Stem Export: Next Pass" to continue, or "Stem Export: Abort" to put your Set back.`));
    }

    const manifest = loadManifest(manifestPath(storageDir, song));
    if (!manifest) throw new Error(`The saved mapping for "${song}" is missing; cannot finalize.`);

    const bridge = await this.bridgeFor(song);
    // The author's state is already safe on disk, and the renders are in hand, so a restore that
    // cannot find every track (renamed or deleted since the last export) must not stop the write.
    // It is reported, and the run record is kept so Abort can still put back what is found.
    let restoreFailure: string | null = null;
    try {
      await restoreAuthorState(bridge, state);
    } catch (e) {
      restoreFailure = (e as Error).message;
    }

    const outDir = join(storageDir, "out");
    const r = finalize(state, manifest, outDir);
    // The record and the collected renders stay until finalize succeeds and the Set is fully back,
    // so Finish can be retried.
    if (r.ok) {
      // Spec section 7: the gain is recorded so a later change of target is a multiply over the existing files.
      saveManifest({ ...manifest, appliedGainDb: r.appliedGainDb }, manifestPath(storageDir, song));
      if (!restoreFailure) {
        clearRunState(path);
        cleanCollected(tempDir, song);
      }
    }
    const ok = r.ok && restoreFailure === null;

    const lines = [
      ...stemScoreLines(r.stemScores),
      restoreFailure === null
        ? `Your mutes, solos and Master devices are back as you left them.`
        : `Your Set was NOT fully restored.`,
      `Output folder: ${join(outDir, safeName(song))}`,
      `${r.files.length} file${r.files.length === 1 ? "" : "s"} written` +
        (r.overwritten.length ? `, ${r.overwritten.length} replaced from an earlier export` : "") + ".",
      r.appliedGainDb === null ? "Gain: not computed." : `One gain applied to every file: ${r.appliedGainDb.toFixed(2)} dB.`,
      r.residualDb === null
        ? "Null test: did not run."
        : `Null test residual: ${r.residualDb.toFixed(2)} dBFS (stems summed against the Master reference).`,
      ...r.notes.map((n) => `Note: ${n}`),
      ...(restoreFailure === null ? [] : [`PROBLEM (restore): ${restoreFailure}`]),
      ...r.problems.map((p) => `PROBLEM (${p.code}): ${p.message}`),
      ok
        ? `Drag the folder into your library when you are happy with it.`
        : r.problems.some((p) => p.code === "null-failed")
          // Finish again re-reads the same renders, so it cannot change a failed null test.
          ? `The null test failed, and running Stem Export: Finish again will not change that result. The way forward is ` +
            `Stem Export: Abort, then run Stem Export again and re-export. The usual cause is a processed group split ` +
            `across stems (the pre-flight warning names it).`
          : `Not clean. The run is kept: fix the above and run Stem Export: Finish again, or Stem Export: Abort to discard it.`,
    ];
    // When the only trouble is a scored null failure, the title says what that means.
    const onlyMismatch = restoreFailure === null && r.stemScores.length > 0 &&
      r.problems.every((p) => p.code === "null-failed");
    const title = ok ? "Stem Export: finished"
      : onlyMismatch ? "Stems written, but they don't fully add up" : "Stem Export: finished with problems";
    await this.host.message({ title, lines });
  }

  async abort(): Promise<void> {
    const recs = runRecords(this.host.storageDir);
    if (recs.length === 0) return void (await this.say("No export in progress", "Nothing to abort."));
    const { outcome, note } = await this.resolveRecord(recs[0]);
    if (outcome === "kept") return;
    const more = runRecords(this.host.storageDir).length;
    await this.host.message({
      title: outcome === "restored" ? "Export aborted" : "Run record discarded",
      lines: [outcome === "restored"
        ? "Your mutes, solos and Master devices are back as you left them."
        : "The run record was deleted.",
        ...(note ? [note] : []),
        ...(more ? [`${more} more unfinished run record${more === 1 ? "" : "s"}: run Stem Export: Abort again.`] : [])],
      buttons: [OK],
    });
  }
}
