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
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { DEFAULT_REGISTRY } from "./default-registry.js";
import {
  BACKING, emptyManifest, loadManifest, manifestPath, resolve, safeName, saveManifest,
  type Manifest, type StemSpec,
} from "./manifest.js";
import { buildPlan } from "./plan.js";
import { stemNames } from "./registry.js";
import {
  advance, applyPass, beginRun, clearRunState, discardRunState, finalize, isStemRender, loadRunState,
  recoverRun, restoreAuthorState, runStatePath, saveRunState,
  type LiveBridge, type RunState,
} from "./run.js";
import type { SongSnapshot } from "./snapshot.js";
import { OK, type MessageSpec } from "./ui/message.js";
import { encodeRequest, parseResponse, type MappingRequest, type MappingResponse } from "./ui/protocol.js";
import { blocking, validate, type Finding, type KeyTap } from "./validate.js";

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
export const songNameFile = (storageDir: string) => join(storageDir, "song-name.txt");

/**
 * The SDK exposes no Set name or path, so the song name cannot be read from Live. This is only the
 * PREFILL for the dialog's name field: the name last confirmed there, kept as the first line of
 * `<storageDirectory>/song-name.txt`, or "Untitled Set" when there is none. Nothing looks a run up
 * by it: an active run is found by scanning `runs/`, and carries its own song name.
 */
export function readSongName(storageDir: string): { name: string; isDefault: boolean } {
  try {
    const first = readFileSync(songNameFile(storageDir), "utf8").split(/\r?\n/)[0].trim();
    if (first) return { name: first, isDefault: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { name: DEFAULT_SONG, isDefault: true };
}

export function rememberSongName(storageDir: string, name: string): void {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(songNameFile(storageDir), name + "\n", "utf8");
}

// ------------------------------------------------------------ manifest <-> dialog

/** The dialog's starting point: which stem each track is assigned to in the saved manifest. */
export function assignmentsOf(m: Manifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [stem, spec] of Object.entries(m.stems)) {
    if (stem === BACKING || spec.computed) continue;
    for (const k of spec.trackKeys) out[k] = stem;
  }
  return out;
}

/** The dialog's reply as a manifest. Backing stays computed; targets and stem suffixes carry over. */
export function manifestFromResponse(base: Manifest, resp: MappingResponse, song: string): Manifest {
  const stems: Record<string, StemSpec> = {};
  for (const [key, stem] of Object.entries(resp.assignments)) {
    if (stem === BACKING) continue;
    const spec = (stems[stem] ??= { trackKeys: [] });
    spec.trackKeys.push(key);
    const suffix = base.stems[stem]?.suffix;
    if (suffix) spec.suffix = suffix;
  }
  stems[BACKING] = { trackKeys: [], computed: true };
  return { ...base, song, stems, extras: resp.extras.map((e) => ({ name: e.name, trackKeys: [...e.trackKeys] })) };
}

/** Validates `m` against the Set as it is NOW. The host never trusts the dialog's own findings. */
export function check(snap: SongSnapshot, m: Manifest, taps: readonly KeyTap[]) {
  const resolution = resolve(m, snap);
  return { resolution, findings: validate(snap, m, resolution, DEFAULT_REGISTRY, taps) };
}

export function requestFor(
  snap: SongSnapshot, m: Manifest, tempDir: string, taps: readonly KeyTap[], extraFindings: Finding[] = [],
): MappingRequest {
  const { resolution, findings } = check(snap, m, taps);
  let outputPreview: MappingRequest["outputPreview"] = [];
  try {
    outputPreview = buildPlan(snap, m, resolution)
      .filter((p) => p.kind === "stem")
      .map((p) => ({ stem: p.name, count: p.include.length, filename: p.outputName }));
  } catch { /* the dialog recomputes its own preview; this is only the seed */ }
  return {
    song: snap.song,
    tempDirectory: tempDir,
    tracks: snap.tracks.map((t) => ({
      key: t.key, name: t.name, depth: t.groupPath.length, isGroup: t.isGroup,
      muted: t.effectiveMuted,   // decided here, once; the page never re-derives it
      devices: [...t.devices],
    })),
    stemNames: [...stemNames(DEFAULT_REGISTRY)],
    current: { assignments: assignmentsOf(m), extras: m.extras.map((e) => ({ name: e.name, trackKeys: [...e.trackKeys] })) },
    findings: [...extraFindings, ...findings],
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
  const dir = collectedDir(tempDir, s.song);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${s.passIndex + 1} - ${safeName(pass.name)}${extname(found[0]).toLowerCase()}`);
  renameSync(found[0], dest);
  return { ...s, collected: { ...s.collected, [pass.name]: dest } };
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
   * Puts the Set back from a record and deletes it. Resolves true when the record is gone (restored
   * or discarded), false when the user declined or it was kept. Never destroys a record it could not
   * restore without being asked: unreadable, mismatched or failing records all offer an explicit
   * discard, which leaves Live untouched.
   */
  private async resolveRecord(rec: RunRecord): Promise<"restored" | "discarded" | "kept"> {
    if (!rec.state) {
      const a = await this.host.message({
        title: "Unreadable run record",
        lines: [`${rec.error}`, `Discarding deletes only the record; Live is not touched, so check your mutes and Master devices yourself.`, rec.path],
        buttons: [DISCARD, CANCEL],
      });
      if (a !== DISCARD.id) return "kept";
      discardRunState(rec.path);
      return "discarded";
    }
    const state = rec.state;
    const bridge = await this.bridgeFor(state.song);

    // The record is matched to the Set by its tracks, not by any name.
    const live = new Set((await bridge.tracks()).map((t) => t.key));
    const absent = Object.keys(state.author.mutes).filter((k) => !live.has(k));
    if (absent.length) {
      const a = await this.host.message({
        title: "This run does not match the open Set",
        lines: [`The unfinished run for "${state.song}" recorded ${absent.length} track${absent.length === 1 ? "" : "s"} that ` +
          `${absent.length === 1 ? "is" : "are"} not in this Set: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", ..." : ""}.`,
          `Either a track was renamed or deleted, or this is a different Set. "Restore what matches" puts back everything it can ` +
          `find; discarding deletes only the record (Live is NOT touched).`],
        buttons: [{ id: "restore", label: "Restore what matches" }, DISCARD, CANCEL],
      });
      if (a === DISCARD.id) { discardRunState(rec.path); return "discarded"; }
      if (a !== "restore") return "kept";
    }
    try {
      const r = await recoverRun(bridge, rec.path, state.song);
      if (r.status === "different-song") throw new Error(`The record belongs to "${r.state.song}".`); // cannot happen: we pass its own name
      cleanCollected(this.host.tempDir, state.song);
      return "restored";
    } catch (e) {
      const a = await this.host.message({
        title: "Could not fully restore your Set",
        lines: [(e as Error).message,
          `The record has been kept. You can discard it to unblock the next export; Live is NOT touched, ` +
          `so fix the items above by hand.`],
        buttons: [{ id: "keep", label: "Keep the record" }, DISCARD],
      });
      if (a !== DISCARD.id) return "kept";
      discardRunState(rec.path);
      return "discarded";
    }
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
      if ((await this.resolveRecord(rec)) === "kept") return;
    }

    const { name: prefill, isDefault } = readSongName(storageDir);
    const snap = await this.host.snapshot(prefill);   // taken AFTER any restore: the author's own state
    const base = loadManifest(manifestPath(storageDir, prefill)) ?? emptyManifest(prefill);
    const note: Finding[] = isDefault ? [{
      severity: "info", rule: "song-name-default", title: "Set the song name",
      detail: `Live does not tell extensions the Set's name. Type it in the Song field; it names every file and the output folder.`,
    }] : [];
    const req = requestFor(snap, base, tempDir, this.host.taps(), note);

    const resp = parseResponse(await this.host.showMapping("data:text/html," + encodeRequest(req)));
    if (resp.cancelled) return;

    const song = resp.song;
    const manifest = manifestFromResponse(base, resp, song);
    // Saved before validating: it is the extension's own storage, the Set is untouched, and a 70-row
    // mapping must survive one fixable error.
    saveManifest(manifest, manifestPath(storageDir, song));
    rememberSongName(storageDir, song);

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
    await this.say(`Stem Export: ${describePass(started)}`,
      `Set Live's export destination to this folder (once), then Export Audio/Video as WAV or AIFF. Keep ` +
      `anything else out of that folder:`,
      tempDir,
      `Any file name will do. When it has finished, run "Stem Export: Next Pass".`,
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
    await restoreAuthorState(bridge, state);   // throws (record kept) if the Set cannot be restored

    const outDir = join(storageDir, "out");
    const r = finalize(state, manifest, outDir);
    // The record and the collected renders stay until finalize succeeds, so Finish can be retried.
    if (r.ok) {
      clearRunState(path);
      cleanCollected(tempDir, song);
    }

    const lines = [
      `Your mutes, solos and Master devices are back as you left them.`,
      `Output folder: ${join(outDir, safeName(song))}`,
      `${r.files.length} file${r.files.length === 1 ? "" : "s"} written` +
        (r.overwritten.length ? `, ${r.overwritten.length} replaced from an earlier export` : "") + ".",
      r.appliedGainDb === null ? "Gain: not computed." : `One gain applied to every file: ${r.appliedGainDb.toFixed(2)} dB.`,
      r.residualDb === null
        ? "Null test: did not run."
        : `Null test residual: ${r.residualDb.toFixed(1)} dBFS (stems summed against the Master reference).`,
      ...r.problems.map((p) => `PROBLEM (${p.code}): ${p.message}`),
      r.ok
        ? `Drag the folder into your library when you are happy with it.`
        : `Not clean. The run is kept: fix the above and run Stem Export: Finish again, or Stem Export: Abort to discard it.`,
    ];
    await this.host.message({ title: r.ok ? "Stem Export: finished" : "Stem Export: finished with problems", lines });
  }

  async abort(): Promise<void> {
    const recs = runRecords(this.host.storageDir);
    if (recs.length === 0) return void (await this.say("No export in progress", "Nothing to abort."));
    const outcome = await this.resolveRecord(recs[0]);
    if (outcome === "kept") return;
    const more = runRecords(this.host.storageDir).length;
    await this.host.message({
      title: outcome === "restored" ? "Export aborted" : "Run record discarded",
      lines: [outcome === "restored"
        ? "Your mutes, solos and Master devices are back as you left them."
        : "Live was not touched; check your mutes and Master devices yourself.",
        ...(more ? [`${more} more unfinished run record${more === 1 ? "" : "s"}: run Stem Export: Abort again.`] : [])],
      buttons: [OK],
    });
  }
}
