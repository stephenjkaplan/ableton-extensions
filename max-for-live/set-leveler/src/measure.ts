// Reads audio and measures a clip's loudest stretch. Node stdlib plus stem export's audio code.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { kWeighting, readWav, truePeakDb, type Audio, type Biquad } from "../../../extensions/stem-export/src/audio.js";
import type { Measure, SessionClip } from "./types.js";

const WINDOW_SECONDS = 3; // short-term loudness, BS.1770
const HOP_SECONDS = 0.1;
const PERCENTILE = 0.95;
const FLOOR_LUFS = -70;

/** Squared K-weighted samples, summed per hop, for one channel. Doesn't keep the filtered audio. */
function hopEnergies(ch: Float64Array, stages: Biquad[], hop: number): Float64Array {
  const hops = Math.floor(ch.length / hop);
  const out = new Float64Array(hops);
  const state = stages.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  for (let i = 0; i < hops * hop; i++) {
    let v = ch[i];
    for (let s = 0; s < stages.length; s++) {
      const { b, a } = stages[s];
      const m = state[s];
      const y = b[0] * v + b[1] * m.x1 + b[2] * m.x2 - a[1] * m.y1 - a[2] * m.y2;
      m.x2 = m.x1; m.x1 = v;
      m.y2 = m.y1; m.y1 = y;
      v = y;
    }
    out[Math.floor(i / hop)] += v * v;
  }
  return out;
}

/** The 95th percentile of short-term LUFS. Null for silence, or anything under one 3 second window. */
export function loudestStretch(a: Audio): number | null {
  const { stage1, stage2 } = kWeighting(a.sampleRate);
  const hop = Math.round(HOP_SECONDS * a.sampleRate);
  const windowHops = Math.round(WINDOW_SECONDS / HOP_SECONDS);
  const perChannel = a.channels.map((ch) => hopEnergies(ch, [stage1, stage2], hop));
  const hops = perChannel[0].length;
  if (hops < windowHops) return null;

  // Live plays a mono file on both sides, so it counts as two channels.
  const channelWeight = a.channels.length === 1 ? 2 : 1;
  const total = new Float64Array(hops);
  for (const e of perChannel) for (let i = 0; i < hops; i++) total[i] += e[i] * channelWeight;

  const values: number[] = [];
  let running = 0;
  for (let i = 0; i < hops; i++) {
    running += total[i];
    if (i >= windowHops) running -= total[i - windowHops];
    if (i >= windowHops - 1) {
      const lufs = -0.691 + 10 * Math.log10(Math.max(running, 0) / (windowHops * hop));
      if (lufs > FLOOR_LUFS) values.push(lufs);
    }
  }
  if (values.length === 0) return null;
  values.sort((x, y) => x - y);
  return values[Math.floor(PERCENTILE * values.length)];
}

/** The part of the file a clip plays, in seconds. Unwarped clips, or ones without a usable map, use the whole file. */
export function playedSeconds(clip: SessionClip, fileSeconds: number): { start: number; end: number } {
  const m = clip.warpMarkers;
  if (!clip.warping || m.length < 2) return { start: 0, end: fileSeconds };
  const toSeconds = (beat: number) => {
    let i = 0;
    while (i < m.length - 2 && beat > m[i + 1].beatTime) i++;
    const [p, q] = [m[i], m[i + 1]];
    return p.sampleTime + ((beat - p.beatTime) * (q.sampleTime - p.sampleTime)) / (q.beatTime - p.beatTime);
  };
  const clamp = (s: number) => Math.min(Math.max(s, 0), fileSeconds);
  return { start: clamp(toSeconds(clip.loopStart)), end: clamp(toSeconds(clip.loopEnd)) };
}

/** Decodes anything that isn't a WAV stem export can read through macOS afconvert. Throws if it can't. */
export function loadAudio(path: string): Audio {
  if (extname(path).toLowerCase() === ".wav") {
    try {
      return readWav(path);
    } catch {
      // Falls through: afconvert handles WAV flavours readWav doesn't.
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "set-leveler-"));
  try {
    const out = join(dir, "decoded.wav");
    execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32", path, out], { stdio: "ignore" });
    return readWav(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function measureClip(clip: SessionClip): Measure {
  try {
    const a = loadAudio(clip.filePath);
    const { start, end } = playedSeconds(clip, a.frames / a.sampleRate);
    const from = Math.floor(start * a.sampleRate);
    const to = Math.floor(end * a.sampleRate);
    const part: Audio = { channels: a.channels.map((ch) => ch.subarray(from, to)), sampleRate: a.sampleRate, frames: to - from };
    const loudestLufs = loudestStretch(part);
    const peakDb = truePeakDb(part);
    return { loudestLufs, peakDb: Number.isFinite(peakDb) ? peakDb : null };
  } catch {
    return { loudestLufs: null, peakDb: null };
  }
}
