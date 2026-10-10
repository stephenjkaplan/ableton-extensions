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
export interface LiveTrack { key: string; setMute(v: boolean): void; getMute(): boolean }
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

export function runStatePath(storageDir: string): string {
  return join(storageDir, "run-state.json");
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
    !isBoolRecord(d.author.mutes) || !isBoolRecord(d.author.masterEnabled)
  ) {
    throw new Error(`Invalid run state in ${path}`);
  }
  return d as unknown as RunState;
}

export function clearRunState(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// -------------------------------------------------------------- collisions

/** Case-folded: macOS volumes are case-insensitive by default. */
const fold = (n: string) => n.normalize("NFC").toLowerCase();

/** Where a written render lives, relative to the song folder. Master references are not written. */
function relOutput(p: Pass): string | null {
  if (p.kind === "master") return null;
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
    if (rel === null) continue;
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
  for (const [key, t] of trackMap(await b.tracks())) mutes[key] = t.getMute();
  const devices = await b.masterDevices();
  const keys = deviceKeys(devices.map((d) => d.name));
  const masterEnabled: Record<string, boolean> = {};
  for (let i = 0; i < devices.length; i++) masterEnabled[keys[i]] = await devices[i].isEnabled();

  const state: RunState = {
    song, passIndex: 0, passes, author: { mutes, masterEnabled }, collected: {},
  };

  // --- persist BEFORE the first mutation ---
  saveRunState(state, statePath);

  // --- mutate ---
  try {
    const toBypass = devices.filter((_, i) => masterEnabled[keys[i]]);
    await b.transaction(() => Promise.all(toBypass.map((d) => d.setEnabled(false))));
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
 * Sets the Set to this pass's mute state, always computed from the AUTHOR baseline (never from
 * the previous pass): excluded tracks muted, everything else at the author's own mute state.
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

  await b.transaction(() => {
    for (const [key, v] of want) tracks.get(key)!.setMute(v);
  });

  const wrong = pass.exclude.filter((k) => !tracks.get(k)!.getMute());
  if (wrong.length) throw new Error(`Live did not mute: ${wrong.join(", ")}`);
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
        try { tracks.get(k)!.setMute(v); } catch (e) { failures.push(`track "${k}": ${String(e)}`); }
      }
    });
    for (const [k, v] of present) {
      if (tracks.get(k)!.getMute() !== v) failures.push(`track "${k}" did not return to mute=${v}`);
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

/**
 * Cold-start recovery: if a run state file exists, restore from it and delete it.
 * Returns the state that was restored, or null when there was nothing to recover.
 * If restoring fails the file is left in place.
 */
export async function recoverRun(b: LiveBridge, statePath: string): Promise<RunState | null> {
  const s = loadRunState(statePath);
  if (!s) return null;
  await restoreAuthorState(b, s);
  clearRunState(statePath);
  return s;
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

/** The null test passes below this residual (dBFS); see nullResidualDb. */
export const NULL_THRESHOLD_DB = -60;

export type FinalizeProblemCode =
  | "collision" | "missing-render" | "unreadable" | "stems-unusable"
  | "no-master-reference" | "master-silent" | "null-failed" | "write-failed";
export interface FinalizeProblem { code: FinalizeProblemCode; message: string }
export interface FinalizeResult {
  files: string[];
  /** null if no gain could be computed */
  appliedGainDb: number | null;
  /** null if the null test could not run or was meaningless (see problems) */
  residualDb: number | null;
  ok: boolean;
  problems: FinalizeProblem[];
}

/**
 * Sums the stem renders, derives ONE gain for the song, applies it to every stem and extra, and
 * writes them under `<outDir>/<safeName(song)>/` (extras in `Extras/`). Then null-tests the
 * stem sum against the Master reference.
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
      if (!(peak >= NULL_THRESHOLD_DB)) {
        add("master-silent",
            `The Master reference is silent or too quiet to verify against (peak ${peak} dBFS); ` +
            `a null result against it would be meaningless.`);
      } else {
        residual = nullResidualDb([applyGain(sum!, gain)], ref, gain);
        if (!(residual < NULL_THRESHOLD_DB)) {
          add("null-failed",
              `Stems do not sum to the Master: residual ${residual} dBFS (needs < ${NULL_THRESHOLD_DB}).`);
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
  for (const p of [...stems, ...extras]) {
    const rel = relOutput(p)!;
    const dest = join(songDir, ...rel.split("/"));
    if (!dest.startsWith(songDir + sep)) {   // defence in depth; safeName should make this unreachable
      add("write-failed", `"${p.name}" resolves outside the output folder.`);
      continue;
    }
    try {
      const gained = applyGain(readWav(s.collected[p.name]), gain);
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
