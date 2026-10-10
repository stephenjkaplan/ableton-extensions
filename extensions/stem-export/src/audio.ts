// Pure audio: WAV I/O, BS.1770-4 loudness, per-song gain, null test.
// Node stdlib only. Imports nothing from the rest of the extension.
import { readFileSync, writeFileSync } from "node:fs";

/** Thrown when audio buffers cannot be summed/compared sample-for-sample. */
export class SumMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SumMismatch";
  }
}

export interface Audio {
  channels: Float64Array[];
  sampleRate: number;
  frames: number;
}

// ---------------------------------------------------------------- WAV read

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function readWav(path: string): Audio {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let dataStart = -1;
  let dataLen = 0;

  // Walk the chunks. Live writes chunks besides fmt/data, and `data` need not be second.
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) throw new Error(`${path}: truncated fmt chunk`);
      let format = buf.readUInt16LE(body);
      if (format === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 26 || body + 26 > buf.length) throw new Error(`${path}: truncated WAVE_FORMAT_EXTENSIBLE fmt chunk`);
        format = buf.readUInt16LE(body + 24); // first two bytes of the SubFormat GUID
      }
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      // Tolerate a size that overruns the file (streamed/unfinalised writers).
      dataLen = Math.min(size, buf.length - body);
      if (fmt) break;
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new Error(`${path}: no fmt chunk`);
  if (dataStart < 0) throw new Error(`${path}: no data chunk`);

  const { format, channels: nch, sampleRate, bits } = fmt;
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_FLOAT) {
    throw new Error(`${path}: unsupported WAV audioFormat ${format} (only PCM=1 and IEEE float=3)`);
  }
  if (nch < 1) throw new Error(`${path}: WAV declares ${nch} channels`);
  const supported =
    format === WAVE_FORMAT_PCM ? bits === 16 || bits === 24 || bits === 32 : bits === 32 || bits === 64;
  if (!supported) {
    throw new Error(`${path}: unsupported ${format === WAVE_FORMAT_PCM ? "PCM" : "float"} bit depth ${bits}`);
  }

  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * nch));
  const channels = Array.from({ length: nch }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const o = dataStart + (i * nch + c) * bytes;
      let v: number;
      if (format === WAVE_FORMAT_FLOAT) {
        v = bits === 32 ? buf.readFloatLE(o) : buf.readDoubleLE(o);
      } else if (bits === 16) {
        v = buf.readInt16LE(o) / 0x8000;
      } else if (bits === 24) {
        v = buf.readIntLE(o, 3) / 0x800000;
      } else {
        v = buf.readInt32LE(o) / 0x80000000;
      }
      channels[c][i] = v;
    }
  }
  return { channels, sampleRate, frames };
}

// --------------------------------------------------------------- WAV write

const MAX_24 = 1 - 2 ** -23;

export function writeWav24(path: string, a: Audio): void {
  const nch = a.channels.length;
  const dataLen = a.frames * nch * 3;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(a.sampleRate, 24);
  buf.writeUInt32LE(a.sampleRate * nch * 3, 28);
  buf.writeUInt16LE(nch * 3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);

  let o = 44;
  for (let i = 0; i < a.frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.min(MAX_24, Math.max(-1, a.channels[c][i]));
      buf.writeIntLE(Math.round(x * 0x800000), o, 3);
      o += 3;
    }
  }
  writeFileSync(path, buf);
}

// -------------------------------------------------------------------- sums

function checkSameShape(a: Audio, b: Audio, what: string): void {
  if (a.sampleRate !== b.sampleRate) {
    throw new SumMismatch(`${what}: sample rate mismatch (${a.sampleRate} vs ${b.sampleRate})`);
  }
  if (a.channels.length !== b.channels.length) {
    throw new SumMismatch(`${what}: channel count mismatch (${a.channels.length} vs ${b.channels.length})`);
  }
  if (a.frames !== b.frames) {
    throw new SumMismatch(`${what}: length mismatch (${a.frames} vs ${b.frames} frames)`);
  }
}

/** Sample-accurate sum. Never pads, trims or resamples: any shape difference throws. */
export function sumAudio(items: readonly Audio[]): Audio {
  if (items.length === 0) throw new SumMismatch("sumAudio: nothing to sum");
  const first = items[0];
  for (let k = 1; k < items.length; k++) checkSameShape(first, items[k], `item ${k}`);
  const channels = first.channels.map((_, c) => {
    const out = new Float64Array(first.frames);
    for (const it of items) {
      const src = it.channels[c];
      for (let i = 0; i < first.frames; i++) out[i] += src[i];
    }
    return out;
  });
  return { channels, sampleRate: first.sampleRate, frames: first.frames };
}

// ---------------------------------------------------------------- loudness

// ITU-R BS.1770-4 K-weighting, 48 kHz only.
const STAGE1 = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1, -1.69065929318241, 0.73248077421585],
};
const STAGE2 = {
  b: [1.0, -2.0, 1.0],
  a: [1, -1.99004745483398, 0.99007225036621],
};

function biquad(x: Float64Array, c: { b: number[]; a: number[] }): Float64Array {
  const y = new Float64Array(x.length);
  const [b0, b1, b2] = c.b;
  const [, a1, a2] = c.a;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi;
    y2 = y1; y1 = yi;
  }
  return y;
}

/**
 * Gated integrated loudness in LUFS. Channels are weighted 1.0 (L/R). Returns
 * -Infinity when nothing survives the absolute gate (silence, or shorter than one block).
 */
export function integratedLufs(a: Audio): number {
  if (a.sampleRate !== 48000) {
    throw new Error(
      `integratedLufs: only 48 kHz is supported (got ${a.sampleRate} Hz); K-weighting coefficients are 48 kHz-specific`,
    );
  }
  const block = Math.round(0.4 * a.sampleRate); // 400 ms
  const hop = Math.round(0.1 * a.sampleRate); // 100 ms => 75% overlap

  // Running sums of squared K-weighted samples, per channel.
  const cumul = a.channels.map((ch) => {
    const k = biquad(biquad(ch, STAGE1), STAGE2);
    const c = new Float64Array(k.length + 1);
    for (let i = 0; i < k.length; i++) c[i + 1] = c[i] + k[i] * k[i];
    return c;
  });

  const energies: number[] = []; // sum_ch(G * meanSquare) per block
  for (let s = 0; s + block <= a.frames; s += hop) {
    let e = 0;
    for (const c of cumul) e += (c[s + block] - c[s]) / block;
    energies.push(e);
  }

  const toLufs = (e: number) => -0.691 + 10 * Math.log10(e);
  const abs = energies.filter((e) => toLufs(e) >= -70);
  if (abs.length === 0) return -Infinity;
  const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
  const relThreshold = toLufs(mean(abs)) - 10;
  const rel = abs.filter((e) => toLufs(e) >= relThreshold);
  return toLufs(mean(rel));
}

/**
 * Sample peak in dBFS (sufficient here). -Infinity for digital silence.
 * +Infinity if any sample is not finite, so corrupt audio can never read as a perfect null.
 */
export function truePeakDb(a: Audio): number {
  let peak = 0;
  for (const ch of a.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (!Number.isFinite(v)) return Infinity;
      if (v > peak) peak = v;
    }
  }
  return 20 * Math.log10(peak);
}

/** One gain for a whole song: reach `targetLufs`, but never push the peak past `ceilingDb`. */
export function gainFor(a: Audio, targetLufs: number, ceilingDb: number): number {
  const lufs = integratedLufs(a);
  if (!Number.isFinite(lufs)) {
    throw new Error("gainFor: cannot measure loudness (silent, or shorter than 400 ms)");
  }
  return Math.min(targetLufs - lufs, ceilingDb - truePeakDb(a));
}

export function applyGain(a: Audio, gainDb: number): Audio {
  const g = 10 ** (gainDb / 20);
  return {
    channels: a.channels.map((ch) => ch.map((v) => v * g)),
    sampleRate: a.sampleRate,
    frames: a.frames,
  };
}

/**
 * Peak (dBFS) of master minus the stem sum with the applied gain undone.
 * Below about -60 means the stems account for the whole mix.
 */
export function nullResidualDb(stems: readonly Audio[], master: Audio, gainDb: number): number {
  const sum = applyGain(sumAudio(stems), -gainDb);
  checkSameShape(sum, master, "master");
  const diff: Audio = {
    channels: sum.channels.map((ch, c) => ch.map((v, i) => v - master.channels[c][i])),
    sampleRate: sum.sampleRate,
    frames: sum.frames,
  };
  return truePeakDb(diff);
}
