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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { extname, join } from "node:path";
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
}

// ------------------------------------------------------------------ song name

export const DEFAULT_SONG = "Untitled Set";
export const songNameFile = (storageDir: string) => join(storageDir, "song-name.txt");

/**
 * The SDK exposes no Set name or path, so the song name cannot be read from Live. It is the first
 * line of `<storageDirectory>/song-name.txt`, or "Untitled Set" when that file is absent or blank.
 * `isDefault` lets the dialog say so.
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

/**
 * Claims the one new render in the export folder for the CURRENT pass: moves it into
 * `<temp>/collected/<song>/` (so re-using one filename for every export is safe) and records it.
 * Idempotent if the current pass was already collected. Throws, changing nothing, on zero or
 * several candidates. Returns the updated state; the caller persists it.
 */
export function collectRender(s: RunState, tempDir: string): RunState {
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
  const dir = join(tempDir, "collected", safeName(s.song));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${s.passIndex + 1} - ${safeName(pass.name)}${extname(found[0]).toLowerCase()}`);
  renameSync(found[0], dest);
  return { ...s, collected: { ...s.collected, [pass.name]: dest } };
}

// ------------------------------------------------------------------ commands

const CANCEL = { id: "cancel", label: "Cancel" };

const describePass = (s: RunState) => {
  const p = s.passes[s.passIndex];
  return `Pass ${s.passIndex + 1} of ${s.passes.length}: ${p.name}`;
};

export class Commands {
  constructor(private readonly host: Host) {}

  private song() { return readSongName(this.host.storageDir); }
  private statePath(song: string) { return runStatePath(this.host.storageDir, song); }
  private say(title: string, ...lines: string[]) { return this.host.message({ title, lines }); }

  /** Rolls back and forgets a run whose pass could not be applied. Never throws. */
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
   * A previous run's state file stands in the way. Returns true when the way is clear (nothing there,
   * or it was restored/discarded), false when the user declined. Handles all three recoverRun
   * outcomes, and offers discardRunState for a run that cannot be restored.
   */
  private async clearLeftover(bridge: LiveBridge, song: string, statePath: string): Promise<boolean> {
    if (!existsSync(statePath)) return true;
    const discard = { id: "discard", label: "Discard the record" };

    let peek: RunState | null;
    try {
      peek = loadRunState(statePath);
    } catch (e) {
      const a = await this.host.message({
        title: "Unreadable run record",
        lines: [`A previous run left a record that cannot be read (${(e as Error).message}).`,
          `Discarding it deletes only that record; Live is not touched, so check your mutes and Master devices yourself.`,
          statePath],
        buttons: [discard, CANCEL],
      });
      if (a !== discard.id) return false;
      discardRunState(statePath);
      return true;
    }
    if (!peek) return true;

    if (peek.song !== song) {
      const a = await this.host.message({
        title: "A run for another song is unfinished",
        lines: [`The record belongs to "${peek.song}", but the open song is "${song}".`,
          `Nothing has been changed. Open "${peek.song}" and run Stem Export: Abort to restore it, ` +
          `or discard the record here (Live is NOT touched; if "${peek.song}" is still muted or its Master is bypassed, fix that by hand).`],
        buttons: [discard, CANCEL],
      });
      if (a !== discard.id) return false;
      discardRunState(statePath);
      return true;
    }

    const go = await this.host.message({
      title: "A run is already in progress",
      lines: [`${describePass(peek)}. Starting again first restores your mutes, solos and Master devices, ` +
        `and forgets the renders collected so far.`],
      buttons: [{ id: "restart", label: "Restore and start over" }, CANCEL],
    });
    if (go !== "restart") return false;

    try {
      const r = await recoverRun(bridge, statePath, song);
      if (r.status === "different-song") {   // cannot happen after the check above; never fall through
        throw new Error(`The record belongs to "${r.state.song}".`);
      }
      return true;   // "restored", or "none" if the record vanished meanwhile
    } catch (e) {
      const a = await this.host.message({
        title: "Could not restore the previous run",
        lines: [(e as Error).message,
          `You can discard the record to start fresh. Live is NOT touched, so check your mutes and Master devices yourself.`],
        buttons: [discard, CANCEL],
      });
      if (a !== discard.id) return false;
      discardRunState(statePath);
      return true;
    }
  }

  async configure(): Promise<void> {
    const { storageDir, tempDir } = this.host;
    const { name: song, isDefault } = this.song();
    const statePath = this.statePath(song);

    if (existsSync(statePath)) {
      // This snapshot is only for matching keys while restoring; a leftover run means the Set is
      // still mutated, so it must not be the one the dialog is built from.
      const bridge = this.host.bridge(await this.host.snapshot(song));
      if (!(await this.clearLeftover(bridge, song, statePath))) return;
    }
    const snap = await this.host.snapshot(song);   // taken AFTER any restore: the author's own state

    const mPath = manifestPath(storageDir, song);
    const base = loadManifest(mPath) ?? emptyManifest(song);
    const note: Finding[] = isDefault ? [{
      severity: "info", rule: "song-name-default", title: "Using the default song name",
      detail: `Live does not tell extensions the Set's name. To name this song, put its name on the first ` +
        `line of ${songNameFile(storageDir)} and run Stem Export again.`,
    }] : [];
    const req = requestFor(snap, base, tempDir, this.host.taps(), note);

    const resp = parseResponse(await this.host.showMapping("data:text/html," + encodeRequest(req)));
    if (resp.cancelled) return;

    // Never trust the dialog's displayed findings: re-validate, against the Set as it is now.
    const manifest = manifestFromResponse(base, resp, song);
    const fresh = await this.host.snapshot(song);
    const { resolution, findings } = check(fresh, manifest, this.host.taps());
    const errors = blocking(findings);
    if (errors.length) {
      await this.say("Cannot start the export",
        ...errors.map((f) => `${f.title}: ${f.detail}`),
        "Nothing was changed and the mapping was not saved.");
      return;
    }

    const passes = buildPlan(fresh, manifest, resolution);
    saveManifest(manifest, mPath);

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
      `Set Live's export destination to this folder (once), then Export Audio/Video:`,
      tempDir,
      `Any file name will do. When it has finished, run "Stem Export: Next Pass".`);
  }

  /** Collects the render for the current pass, then moves to and applies the next. */
  async next(): Promise<void> {
    const { name: song } = this.song();
    const statePath = this.statePath(song);
    const state = loadRunState(statePath);
    if (!state) return void (await this.say("No export in progress", "Run Stem Export first."));
    if (state.song !== song) {
      return void (await this.say("Run belongs to another song",
        `The unfinished run is for "${state.song}"; the open song is "${song}". Open "${state.song}" and run Stem Export: Abort.`));
    }
    if (state.passIndex + 1 >= state.passes.length) {
      return void (await this.say("That was the last pass",
        `Run "Stem Export: Finish" to level and write the stems.`));
    }

    const collected = collectRender(state, this.host.tempDir);
    const moved = advance(collected);
    saveRunState(moved, statePath);   // persisted before touching Live, like beginRun does

    const bridge = this.host.bridge(await this.host.snapshot(song));
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
    const { name: song } = this.song();
    const statePath = this.statePath(song);
    const state = loadRunState(statePath);
    if (!state) return void (await this.say("No export in progress", "Run Stem Export first."));
    if (state.song !== song) {
      return void (await this.say("Run belongs to another song",
        `The unfinished run is for "${state.song}"; the open song is "${song}". Open "${state.song}" and run Stem Export: Abort.`));
    }

    // Everything must be in hand BEFORE the Set is touched, so a premature Finish changes nothing.
    const collected = collectRender(state, tempDir);
    saveRunState(collected, statePath);
    const missing = collected.passes.filter((p) => collected.collected[p.name] === undefined).map((p) => p.name);
    if (missing.length) {
      return void (await this.say("Not every pass has been exported",
        `Still missing: ${missing.join(", ")}.`,
        `Use "Stem Export: Next Pass" to continue, or "Stem Export: Abort" to put your Set back.`));
    }

    const manifest = loadManifest(manifestPath(storageDir, song));
    if (!manifest) throw new Error(`The saved mapping for "${song}" is missing; cannot finalize.`);

    const bridge = this.host.bridge(await this.host.snapshot(song));
    await restoreAuthorState(bridge, collected);   // throws (record kept) if the Set cannot be restored

    const outDir = join(storageDir, "out");
    const r = finalize(collected, manifest, outDir);
    clearRunState(statePath);

    const songDir = join(outDir, safeName(song));
    const lines = [
      `Your mutes, solos and Master devices are back as you left them.`,
      `Output folder: ${songDir}`,
      `${r.files.length} file${r.files.length === 1 ? "" : "s"} written` +
        (r.overwritten.length ? `, ${r.overwritten.length} replaced from an earlier export` : "") + ".",
      r.appliedGainDb === null ? "Gain: not computed." : `One gain applied to every file: ${r.appliedGainDb.toFixed(2)} dB.`,
      r.residualDb === null
        ? "Null test: did not run."
        : `Null test residual: ${r.residualDb.toFixed(1)} dBFS (stems summed against the Master reference).`,
      ...r.problems.map((p) => `PROBLEM (${p.code}): ${p.message}`),
      r.ok ? `Drag the folder into your library when you are happy with it.` : `Not clean: fix the above before using these files.`,
    ];
    await this.host.message({ title: r.ok ? "Stem Export: finished" : "Stem Export: finished with problems", lines });
  }

  async abort(): Promise<void> {
    const { name: song } = this.song();
    const statePath = this.statePath(song);
    const discard = { id: "discard", label: "Discard the record" };

    let state: RunState | null;
    try {
      state = loadRunState(statePath);
    } catch (e) {
      const a = await this.host.message({
        title: "Unreadable run record",
        lines: [`${(e as Error).message}`, `Discarding deletes only the record; Live is not touched.`],
        buttons: [discard, CANCEL],
      });
      if (a === discard.id) discardRunState(statePath);
      return;
    }
    if (!state) return void (await this.say("No export in progress", "Nothing to abort."));

    if (state.song !== song) {
      const a = await this.host.message({
        title: "Run belongs to another song",
        lines: [`The record is for "${state.song}"; the open song is "${song}". Open "${state.song}" to restore it, ` +
          `or discard the record here (Live is NOT touched).`],
        buttons: [discard, CANCEL],
      });
      if (a === discard.id) discardRunState(statePath);
      return;
    }

    const bridge = this.host.bridge(await this.host.snapshot(song));
    try {
      await restoreAuthorState(bridge, state);
    } catch (e) {
      const a = await this.host.message({
        title: "Could not fully restore your Set",
        lines: [(e as Error).message,
          `The record has been kept. You can discard it to unblock the next export; Live is NOT touched, ` +
          `so fix the items above by hand.`],
        buttons: [{ id: "keep", label: "Keep the record" }, discard],
      });
      if (a === discard.id) discardRunState(statePath);
      return;
    }
    clearRunState(statePath);
    await this.host.message({
      title: "Export aborted",
      lines: ["Your mutes, solos and Master devices are back as you left them."], buttons: [OK],
    });
  }
}
