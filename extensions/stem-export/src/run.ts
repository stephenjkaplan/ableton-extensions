// Run engine: captures the author's mixer state, bypasses the Master, applies per-pass mute
// sets, and finalizes rendered files. SDK-free: everything goes through LiveBridge (live.ts).
//
// AUTHOR STATE IS SACRED. This is the only module that mutates the open Live Set. The rules:
//   1. beginRun persists the captured author state to disk BEFORE it mutates anything.
//   2. beginRun refuses to start while a state file already exists, because the live Set would
//      then already be mutated and "capturing" it would overwrite the true original.
//   3. restoreAuthorState needs nothing but the RunState loaded from that file.
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import {
  SumMismatch, applyGain, gainFor, nullResidualDb, readWav, sumAudio, truePeakDb, writeWav24,
  type Audio,
} from "./audio.js";
import { safeName, type Manifest } from "./manifest.js";
import type { Pass } from "./plan.js";

// ------------------------------------------------------------------ bridge

/** Mutations must be started synchronously inside a `transaction` callback. */
export interface LiveTrack {
  key: string;
  setMute(v: boolean): void;
  getMute(): boolean;
  setSolo(v: boolean): void;
  getSolo(): boolean;
}
export interface LiveMasterDevice {
  name: string;
  isEnabled(): Promise<boolean>;
  setEnabled(v: boolean): Promise<void>;
}
export interface LiveBridge {
  tracks(): Promise<LiveTrack[]>;
  masterDevices(): Promise<LiveMasterDevice[]>;
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
}

// ------------------------------------------------------------------- state

export interface AuthorState {
  /** track key -> muted */
  mutes: Record<string, boolean>;
  /**
   * track key -> soloed. A soloed track silences every other track REGARDLESS of mute, so
   * a solo left on would make every pass render the soloed track. Cleared for the run,
   * restored afterwards.
   */
  solos: Record<string, boolean>;
  /** master device key (see deviceKeys) -> enabled */
  masterEnabled: Record<string, boolean>;
}
export interface RunState {
  song: string;
  passIndex: number;
  passes: Pass[];
  author: AuthorState;
  /** pass name -> temp file path of the render */
  collected: Record<string, string>;
}

/**
 * One file per song (like manifestPath). A single global file would let a crash in project A
 * be "restored" onto project B's same-named tracks.
 */
export function runStatePath(storageDir: string, song: string): string {
  return join(storageDir, "runs", `${safeName(song)}.json`);
}

export function saveRunState(s: RunState, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
  renameSync(tmp, path); // atomic: a crash never leaves a half-written record
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isBoolRecord = (v: unknown): v is Record<string, boolean> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "boolean");

/** null if there is no file. Throws on a file that exists but is not a valid RunState. */
export function loadRunState(path: string): RunState | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const d: unknown = JSON.parse(raw);
  if (
    !isRecord(d) || typeof d.song !== "string" || typeof d.passIndex !== "number" ||
    !Array.isArray(d.passes) || !isRecord(d.collected) || !isRecord(d.author) ||
    !isBoolRecord(d.author.mutes) || !isBoolRecord(d.author.masterEnabled) ||
    (d.author.solos !== undefined && !isBoolRecord(d.author.solos))
  ) {
    throw new Error(`Invalid run state in ${path}`);
  }
  // A file without solos predates solo capture; nothing to restore there.
  const author = { ...d.author, solos: d.author.solos ?? {} };
  return { ...d, author } as unknown as RunState;
}

export function clearRunState(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * The explicit way out when a run state cannot be restored (tracks deleted, wrong project,
 * corrupt file): throws the record away WITHOUT touching Live, so beginRun stops refusing.
 * The Set is left exactly as it is. Returns whether there was a file to discard. Never parses.
 */
export function discardRunState(path: string): boolean {
  const had = existsSync(path);
  clearRunState(path);
  return had;
}

// -------------------------------------------------------------- collisions

/** Case-folded: macOS volumes are case-insensitive by default. */
const fold = (n: string) => n.normalize("NFC").toLowerCase();

/** Where a written render lives, relative to the song folder (the Master reference is top level). */
function relOutput(p: Pass): string {
  const f = safeName(p.outputName);
  return p.kind === "extra" ? `Extras/${f}` : f;
}

/**
 * Anything that would make two passes overwrite each other: a shared pass name (the
 * `collected` map is keyed by it) or a shared sanitised, case-folded output path.
 */
export function findCollisions(passes: readonly Pass[]): string[] {
  const out: string[] = [];
  const names = new Map<string, string>();
  const paths = new Map<string, string>([["extras", "the Extras folder"]]);
  for (const p of passes) {
    const nameKey = fold(p.name);
    if (names.has(nameKey)) out.push(`Two passes are both named "${p.name}".`);
    names.set(nameKey, p.name);

    const rel = relOutput(p);
    const pathKey = fold(rel);
    const prior = paths.get(pathKey);
    if (prior !== undefined) out.push(`"${p.name}" would overwrite ${prior} at "${rel}".`);
    else paths.set(pathKey, `"${p.name}"`);
  }
  return out;
}

// ----------------------------------------------------------------- engine

/** Same-named master devices get `#n` (1-based, chain order), like track keys. */
function deviceKeys(names: readonly string[]): string[] {
  const total = new Map<string, number>();
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((n) => {
    if (total.get(n)! < 2) return n;
    const i = (seen.get(n) ?? 0) + 1;
    seen.set(n, i);
    return `${n}#${i}`;
  });
}

function trackMap(tracks: readonly LiveTrack[]): Map<string, LiveTrack> {
  const m = new Map<string, LiveTrack>();
  for (const t of tracks) {
    if (m.has(t.key)) throw new Error(`Duplicate track key from Live: "${t.key}"`);
    m.set(t.key, t);
  }
  return m;
}

/**
 * Captures the author's state, persists it to `statePath`, and only then bypasses the Master.
 * Throws, touching nothing, if a previous run was never restored.
 */
export async function beginRun(
  b: LiveBridge, passes: Pass[], song: string, statePath: string,
): Promise<RunState> {
  const collisions = findCollisions(passes);
  if (collisions.length) throw new Error(`Cannot start: ${collisions.join(" ")}`);

  // A leftover file means a previous run died with the Set still mutated. What Live shows now
  // is NOT the author's state; overwriting the record would lose the only copy of it.
  if (existsSync(statePath)) {
    throw new Error(
      `A previous run was never restored (${statePath}). Restore the author state first.`);
  }

  // --- capture (read-only) ---
  const mutes: Record<string, boolean> = {};
  const solos: Record<string, boolean> = {};
  const live = trackMap(await b.tracks());
  for (const [key, t] of live) {
    mutes[key] = t.getMute();
    solos[key] = t.getSolo();
  }
  const devices = await b.masterDevices();
  const keys = deviceKeys(devices.map((d) => d.name));
  const masterEnabled: Record<string, boolean> = {};
  for (let i = 0; i < devices.length; i++) masterEnabled[keys[i]] = await devices[i].isEnabled();

  const state: RunState = {
    song, passIndex: 0, passes, author: { mutes, solos, masterEnabled }, collected: {},
  };

  // --- persist BEFORE the first mutation ---
  saveRunState(state, statePath);

  // --- mutate ---
  try {
    const toBypass = devices.filter((_, i) => masterEnabled[keys[i]]);
    const soloed = [...live.values()].filter((t) => solos[t.key]);
    const settled = await b.transaction(() => {
      for (const t of soloed) t.setSolo(false);
      // allSettled, not all: on a first failure `all` rejects while other disables are still
      // in flight, and the rollback below could then race a late disable and lose.
      // `async` so a synchronous throw becomes a rejection rather than skipping the rest.
      return Promise.allSettled(toBypass.map(async (d) => d.setEnabled(false)));
    });
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const stillSoloed = [...live.values()].filter((t) => t.getSolo()).map((t) => t.key);
    if (stillSoloed.length) throw new Error(`Live did not clear solo on: ${stillSoloed.join(", ")}`);
  } catch (err) {
    // Roll back what we can. Keep the state file unless the rollback fully succeeded.
    try {
      await restoreAuthorState(b, state);
      clearRunState(statePath);
    } catch {
      /* state file stays on disk for recovery */
    }
    throw err;
  }
  return state;
}

/**
 * Sets the Set to this pass's state, always computed from the AUTHOR baseline (never from
 * the previous pass): excluded tracks muted, everything else at the author's own mute state,
 * and no track soloed.
 *
 * Deliberate divergence from "unmute the include set": a track in `include` that the author
 * had muted STAYS muted. Plan only includes audible tracks, so this only affects tracks the
 * author silenced after planning; honouring the author's mute is the safer reading.
 *
 * RETURN TRACKS ARE DELIBERATELY NOT TOUCHED. They are not in song.tracks, and must not be
 * muted: when only stem N's members are audible, a return carries only stem N's send
 * contribution, which is exactly what that stem should contain. Muting returns would drop
 * reverb/delay tails from every stem. Do not "fix" this.
 */
export async function applyPass(b: LiveBridge, s: RunState): Promise<void> {
  const pass = s.passes[s.passIndex];
  if (!pass) throw new Error(`No pass at index ${s.passIndex}`);
  const tracks = trackMap(await b.tracks());

  const missing = pass.exclude.filter((k) => !tracks.has(k));
  if (missing.length) {
    throw new Error(`Tracks to mute are no longer in the Set: ${missing.join(", ")}`);
  }
  const exclude = new Set(pass.exclude);
  const want = new Map<string, boolean>();
  for (const [key, t] of tracks) {
    if (exclude.has(key)) want.set(key, true);
    else if (key in s.author.mutes) want.set(key, s.author.mutes[key]);
    else want.set(key, t.getMute()); // added after the run began: leave it alone
  }

  // The author may have soloed something since the last pass; a solo overrides mutes.
  await b.transaction(() => {
    for (const [key, v] of want) {
      const t = tracks.get(key)!;
      t.setMute(v);
      if (t.getSolo()) t.setSolo(false);
    }
  });

  const wrong = pass.exclude.filter((k) => !tracks.get(k)!.getMute());
  if (wrong.length) throw new Error(`Live did not mute: ${wrong.join(", ")}`);
  const soloed = [...tracks.keys()].filter((k) => tracks.get(k)!.getSolo());
  if (soloed.length) throw new Error(`Live did not clear solo on: ${soloed.join(", ")}`);
}

export function advance(s: RunState): RunState {
  if (s.passIndex >= s.passes.length) throw new Error("Already past the last pass");
  return { ...s, passIndex: s.passIndex + 1 };
}

/**
 * Puts every captured mute and Master device back exactly as the author had it. Needs only the
 * RunState (so it works from the file after a crash). Best effort: carries on past individual
 * failures, then throws one error listing everything it could not restore.
 */
export async function restoreAuthorState(b: LiveBridge, s: RunState): Promise<void> {
  const failures: string[] = [];

  try {
    const tracks = trackMap(await b.tracks());
    const present = Object.entries(s.author.mutes).filter(([k]) => {
      if (tracks.has(k)) return true;
      failures.push(`track "${k}" is no longer in the Set`);
      return false;
    });
    await b.transaction(() => {
      for (const [k, v] of present) {
        const t = tracks.get(k)!;
        try {
          t.setMute(v);
          if (k in s.author.solos) t.setSolo(s.author.solos[k]);
        } catch (e) { failures.push(`track "${k}": ${String(e)}`); }
      }
    });
    for (const [k, v] of present) {
      const t = tracks.get(k)!;
      if (t.getMute() !== v) failures.push(`track "${k}" did not return to mute=${v}`);
      if (k in s.author.solos && t.getSolo() !== s.author.solos[k]) {
        failures.push(`track "${k}" did not return to solo=${s.author.solos[k]}`);
      }
    }
  } catch (e) {
    failures.push(`tracks: ${String(e)}`);
  }

  try {
    const devices = await b.masterDevices();
    const keys = deviceKeys(devices.map((d) => d.name));
    const byKey = new Map(keys.map((k, i) => [k, devices[i]]));
    for (const [k, v] of Object.entries(s.author.masterEnabled)) {
      const d = byKey.get(k);
      if (!d) { failures.push(`master device "${k}" is no longer in the Set`); continue; }
      try {
        await b.transaction(() => d.setEnabled(v));
        if ((await d.isEnabled()) !== v) failures.push(`master device "${k}" did not return to enabled=${v}`);
      } catch (e) {
        failures.push(`master device "${k}": ${String(e)}`);
      }
    }
  } catch (e) {
    failures.push(`master devices: ${String(e)}`);
  }

  if (failures.length) throw new Error(`Could not fully restore author state: ${failures.join("; ")}`);
}

export type RecoverResult =
  | { status: "none" }
  | { status: "restored"; state: RunState }
  /** A state file exists but belongs to another song. It is left untouched, Live too. */
  | { status: "different-song"; state: RunState };

/**
 * Cold-start recovery for the OPEN Set (`song`): if its run state file exists, restore from it
 * and delete it. Refuses, touching neither the file nor Live, when the recorded song is not
 * the open one (safeName can map two different songs to one file). If restoring fails the file
 * is left in place and this throws; discardRunState is the way out.
 */
export async function recoverRun(
  b: LiveBridge, statePath: string, song: string,
): Promise<RecoverResult> {
  const s = loadRunState(statePath);
  if (!s) return { status: "none" };
  if (s.song !== song) return { status: "different-song", state: s };
  await restoreAuthorState(b, s);
  clearRunState(statePath);
  return { status: "restored", state: s };
}

// --------------------------------------------------------------- finalize

const RENDER_EXTS = new Set([".wav", ".aif", ".aiff"]);

/**
 * True for a finished audio render: .wav/.aif/.aiff (any case), not a dotfile, not a
 * directory, not empty (still being written). Non-existent paths are judged by name alone.
 */
export function isStemRender(file: string): boolean {
  if (basename(file).startsWith(".")) return false;
  if (!RENDER_EXTS.has(extname(file).toLowerCase())) return false;
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * A Master reference whose peak is below this (dBFS) is treated as silent. Deliberately an
 * ABSOLUTE floor, and well above gainFor's -70 LUFS gate: stems and Master that are both
 * quiet but audible-to-the-meter would otherwise null to -Infinity and "pass".
 */
export const SILENT_MASTER_PEAK_DB = -60;
/** The residual must sit this far below the Master's own peak, so the bar scales with level. */
export const NULL_MARGIN_DB = 60;
/** Peak (dBFS) above which writeWav24 would clamp a sample. */
const CLIP_DB = 20 * Math.log10(1 - 2 ** -23);

export type FinalizeProblemCode =
  | "collision" | "missing-render" | "unreadable" | "stems-unusable"
  | "no-master-reference" | "master-silent" | "null-failed" | "clipped" | "write-failed";
export interface FinalizeProblem { code: FinalizeProblemCode; message: string }
export interface FinalizeResult {
  files: string[];
  /** null if no gain could be computed */
  appliedGainDb: number | null;
  /** null if the null test could not run or was meaningless (see problems). In the render domain (gain undone). */
  residualDb: number | null;
  ok: boolean;
  problems: FinalizeProblem[];
}

/**
 * Sums the stem renders, derives ONE gain for the song (from the stem sum only), applies it to
 * every stem, extra and the Master reference (so sum(stems) == master still holds in the output),
 * and writes them under `<outDir>/<safeName(song)>/` (extras in `Extras/`, the Master reference
 * at top level). Null-tests the stem sum against the Master reference first.
 *
 * A file that would clip after gain (e.g. an extra louder than the stem sum) is NOT written and
 * is reported as `clipped`. Files already at a destination are overwritten (re-export).
 *
 * Nothing is written when the inputs cannot be trusted (collisions, missing or unreadable
 * renders, stems that cannot be summed or measured). A failed or meaningless null test still
 * writes the files but sets ok=false.
 */
export function finalize(s: RunState, m: Manifest, outDir: string): FinalizeResult {
  const problems: FinalizeProblem[] = [];
  const add = (code: FinalizeProblemCode, message: string) => problems.push({ code, message });
  const done = (files: string[], gain: number | null, residual: number | null): FinalizeResult =>
    ({ files, appliedGainDb: gain, residualDb: residual, ok: problems.length === 0, problems });

  for (const c of findCollisions(s.passes)) add("collision", c);
  if (problems.length) return done([], null, null);

  for (const p of s.passes) {
    const f = s.collected[p.name];
    if (f === undefined || !existsSync(f)) add("missing-render", `No render collected for "${p.name}".`);
  }
  if (problems.length) return done([], null, null);

  const stems = s.passes.filter((p) => p.kind === "stem");
  const extras = s.passes.filter((p) => p.kind === "extra");
  const master = s.passes.find((p) => p.kind === "master");
  if (stems.length === 0) {
    add("stems-unusable", "There are no stem passes to finalize.");
    return done([], null, null);
  }

  // Pass 1: sum the stems and measure. Stems are re-read for writing rather than all held in
  // memory at once; a song's stems are large.
  let sum: Audio | undefined;
  let gain: number;
  try {
    for (const p of stems) {
      const a = readWav(s.collected[p.name]);
      sum = sum ? sumAudio([sum, a]) : a;
    }
    gain = gainFor(sum!, m.targetLufs, m.truePeakCeilingDb);
  } catch (err) {
    add(err instanceof SumMismatch ? "stems-unusable" : "unreadable",
        `Cannot sum and measure the stems: ${(err as Error).message}`);
    return done([], null, null);
  }

  // Null test, before writing so the verdict is known. A silent Master would "null" to
  // -Infinity against silent stems, so the reference must be audibly above the threshold.
  let residual: number | null = null;
  if (!master) {
    add("no-master-reference", "No Master reference pass; the stems cannot be verified.");
  } else {
    try {
      const ref = readWav(s.collected[master.name]);
      const peak = truePeakDb(ref);
      if (!(peak >= SILENT_MASTER_PEAK_DB)) {
        add("master-silent",
            `The Master reference is silent or too quiet to verify against (peak ${peak} dBFS, ` +
            `needs >= ${SILENT_MASTER_PEAK_DB}); a null result against it would be meaningless.`);
      } else {
        residual = nullResidualDb([applyGain(sum!, gain)], ref, gain);
        const limit = peak - NULL_MARGIN_DB;
        if (!(residual < limit)) {
          add("null-failed",
              `Stems do not sum to the Master: residual ${residual} dBFS (needs < ${limit}, ` +
              `${NULL_MARGIN_DB} dB under the Master peak of ${peak}).`);
        }
      }
    } catch (err) {
      add("null-failed", `Null test could not run: ${(err as Error).message}`);
    }
  }
  sum = undefined;

  // Pass 2: write.
  const songDir = join(resolvePath(outDir), safeName(s.song));
  const files: string[] = [];
  for (const p of [...stems, ...(master ? [master] : []), ...extras]) {
    const rel = relOutput(p);
    const dest = join(songDir, ...rel.split("/"));
    if (!dest.startsWith(songDir + sep)) {   // defence in depth; safeName should make this unreachable
      add("write-failed", `"${p.name}" resolves outside the output folder.`);
      continue;
    }
    try {
      const gained = applyGain(readWav(s.collected[p.name]), gain);
      const gp = truePeakDb(gained);
      if (!(gp <= CLIP_DB)) {
        add("clipped", `"${p.name}" peaks at ${gp} dBFS after the song gain of ${gain} dB and would clip; not written.`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeWav24(dest + ".partial", gained);
      renameSync(dest + ".partial", dest);
      files.push(dest);
    } catch (err) {
      add("write-failed", `"${p.name}": ${(err as Error).message}`);
    }
  }
  return done(files, gain, residual);
}
