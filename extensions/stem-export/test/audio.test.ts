import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGain, gainFor, integratedLufs, isSupportedSampleRate, kWeighting, nullResidualDb, offRanges, readWav,
         stemScore, SumMismatch, sumAudio, truePeakDb, writeWav24, type Audio } from "../src/audio.js";

function tone(freq = 1000, secs = 3, rate = 48000, amp = 0.1, chans = 2): Audio {
  const frames = Math.floor(secs * rate);
  const channels = Array.from({ length: chans }, () => {
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    return out;
  });
  return { channels, sampleRate: rate, frames };
}
const dir = () => mkdtempSync(join(tmpdir(), "sk-audio-"));

describe("audio", () => {
  it("round-trips a wav through disk, both channels, many samples", () => {
    const p = join(dir(), "a.wav");
    const frames = 2000;
    const L = new Float64Array(frames), R = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      L[i] = 0.5 * Math.sin(i * 0.05);
      R[i] = -0.25 * Math.cos(i * 0.011) + 0.1;
    }
    const a: Audio = { channels: [L, R], sampleRate: 48000, frames };
    writeWav24(p, a);
    const b = readWav(p);
    expect(b.sampleRate).toBe(48000);
    expect(b.frames).toBe(frames);
    expect(b.channels.length).toBe(2);
    for (let i = 0; i < frames; i += 7) {
      expect(Math.abs(b.channels[0][i] - L[i])).toBeLessThan(2 ** -22);
      expect(Math.abs(b.channels[1][i] - R[i])).toBeLessThan(2 ** -22);
    }
  });

  it("writes little-endian 24-bit and clamps to [-1, 1 - 2^-23]", () => {
    const p = join(dir(), "clamp.wav");
    writeWav24(p, { channels: [Float64Array.from([1.5, -1.5, 0.5])], sampleRate: 48000, frames: 3 });
    const raw = readFileSync(p);
    expect(raw.subarray(44, 47)).toEqual(Buffer.from([0xff, 0xff, 0x7f])); // 0x7FFFFF
    expect(raw.subarray(47, 50)).toEqual(Buffer.from([0x00, 0x00, 0x80])); // -0x800000
    expect(raw.subarray(50, 53)).toEqual(Buffer.from([0x00, 0x00, 0x40])); // 0x400000
  });

  it("sums sample-accurately", () => {
    const a = tone(220), b = tone(660);
    const s = sumAudio([a, b]);
    expect(s.channels[0][500]).toBeCloseTo(a.channels[0][500] + b.channels[0][500], 10);
  });

  it("rejects a sample-rate mismatch", () => {
    // Review Focus 4: silently resampling would make the null test lie.
    // Only the rate differs; frame count and channels are identical.
    const bad = { ...tone(440, 1, 48000), sampleRate: 44100 };
    expect(() => sumAudio([tone(440, 1, 48000), bad])).toThrow(SumMismatch);
    expect(() => sumAudio([tone(440, 1, 48000), bad])).toThrow(/sample rate/);
  });

  it("rejects a length mismatch", () => {
    expect(() => sumAudio([tone(440, 2), tone(440, 1.5)])).toThrow(SumMismatch);
    expect(() => sumAudio([tone(440, 2), tone(440, 1.5)])).toThrow(/length/);
  });

  it("rejects a channel-count mismatch", () => {
    expect(() => sumAudio([tone(440, 1, 48000, 0.1, 2), tone(440, 1, 48000, 0.1, 1)]))
      .toThrow(SumMismatch);
    expect(() => sumAudio([tone(440, 1, 48000, 0.1, 2), tone(440, 1, 48000, 0.1, 1)]))
      .toThrow(/channel/);
  });

  it("loudness tracks gain changes one-for-one", () => {
    // The property our normalisation actually depends on.
    const base = integratedLufs(tone());
    expect(integratedLufs(applyGain(tone(), -6))).toBeCloseTo(base - 6, 1);
    expect(integratedLufs(applyGain(tone(), +3))).toBeCloseTo(base + 3, 1);
  });

  it("measures a mono 1 kHz sine at its RMS level", () => {
    const amp = Math.pow(10, -20 / 20);
    expect(integratedLufs(tone(1000, 3, 48000, amp, 1))).toBeCloseTo(-23, 1);
  });

  it("measures a stereo 1 kHz sine at the BS.1770 reference level", () => {
    // -20 dBFS 1 kHz on both channels reads -20.0 LUFS: the standard's calibration point.
    const amp = Math.pow(10, -20 / 20);
    expect(integratedLufs(tone(1000, 3, 48000, amp, 2))).toBeCloseTo(-20, 1);
  });

  it("gainFor hits the target when headroom allows", () => {
    const a = tone(1000, 3, 48000, 0.5);
    const g = gainFor(a, -18, -6);
    expect(integratedLufs(applyGain(a, g))).toBeCloseTo(-18, 1);
  });

  it("gainFor is clamped by the true-peak ceiling", () => {
    // Target gain would be about +42 dB; the -50 dBFS ceiling allows only about +10 dB,
    // so the ceiling, not the target, must decide.
    const quiet = tone(1000, 3, 48000, 0.001);
    const g = gainFor(quiet, -18, -50);
    expect(g).toBeCloseTo(-50 - truePeakDb(quiet), 6);
    expect(g).toBeLessThan(-18 - integratedLufs(quiet));
    expect(integratedLufs(applyGain(quiet, g))).toBeLessThan(-18 - 1);
    expect(truePeakDb(applyGain(quiet, g))).toBeCloseTo(-50, 6);
  });

  it("truePeakDb reports +Infinity for non-finite samples", () => {
    const a = tone(440, 1);
    a.channels[1][100] = NaN;
    expect(truePeakDb(a)).toBe(Infinity);
    a.channels[1][100] = -Infinity;
    expect(truePeakDb(a)).toBe(Infinity);
  });

  it("a NaN sample can never read as a null", () => {
    const a = tone(220), b = tone(660);
    const master = sumAudio([a, b]);
    const corrupt = tone(220);
    corrupt.channels[0][1234] = NaN;
    expect(nullResidualDb([corrupt, b], master, 0)).toBeGreaterThan(-60);
    expect(nullResidualDb([a, b], { ...master, channels: [corrupt.channels[0], master.channels[1]] }, 0))
      .toBeGreaterThan(-60);
  });

  it("nulls to silence for a true partition", () => {
    const a = tone(220), b = tone(660);
    expect(nullResidualDb([a, b], sumAudio([a, b]), 0)).toBeLessThan(-60);
  });

  it("does not null when a stem is missing", () => {
    const a = tone(220), b = tone(660);
    expect(nullResidualDb([a], sumAudio([a, b]), 0)).toBeGreaterThan(-60);
  });

  it("accounts for the applied gain", () => {
    const a = tone(220);
    expect(nullResidualDb([applyGain(a, -8.8)], a, -8.8)).toBeLessThan(-60);
  });

  describe("RIFF parsing of hand-built files", () => {
    const chunk = (id: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.write(id, 0, "ascii");
      head.writeUInt32LE(body.length, 4);
      // Word alignment: odd-sized bodies are followed by one pad byte not counted in the size.
      return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const fmtBody = (format: number, chans: number, rate: number, bits: number): Buffer => {
      const b = Buffer.alloc(16);
      b.writeUInt16LE(format, 0);
      b.writeUInt16LE(chans, 2);
      b.writeUInt32LE(rate, 4);
      b.writeUInt32LE((rate * chans * bits) / 8, 8);
      b.writeUInt16LE((chans * bits) / 8, 12);
      b.writeUInt16LE(bits, 14);
      return b;
    };
    const riff = (...chunks: Buffer[]): Buffer => {
      const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
      const head = Buffer.alloc(8);
      head.write("RIFF", 0, "ascii");
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    const write = (buf: Buffer): string => {
      const p = join(dir(), "h.wav");
      writeFileSync(p, buf);
      return p;
    };
    const i16 = (...v: number[]): Buffer => {
      const b = Buffer.alloc(v.length * 2);
      v.forEach((x, i) => b.writeInt16LE(x, i * 2));
      return b;
    };

    it("skips a LIST chunk sitting before data", () => {
      const list = chunk("LIST", Buffer.from("INFOISFT\x04\x00\x00\x00Live", "latin1"));
      const p = write(riff(chunk("fmt ", fmtBody(1, 1, 48000, 16)), list, chunk("data", i16(16384, -16384, 8192))));
      const a = readWav(p);
      expect(a.frames).toBe(3);
      expect(Array.from(a.channels[0])).toEqual([0.5, -0.5, 0.25]);
    });

    it("honours word alignment after an odd-sized chunk", () => {
      const odd = chunk("junk", Buffer.from([1, 2, 3, 4, 5])); // 5 bytes + 1 pad
      const p = write(riff(odd, chunk("fmt ", fmtBody(1, 1, 48000, 16)), chunk("data", i16(16384, -8192))));
      const a = readWav(p);
      expect(a.frames).toBe(2);
      expect(Array.from(a.channels[0])).toEqual([0.5, -0.25]);
    });

    it("reads audioFormat 3 (32-bit IEEE float), de-interleaving channels", () => {
      const data = Buffer.alloc(16);
      [0.5, -0.5, 0.25, -0.25].forEach((v, i) => data.writeFloatLE(v, i * 4));
      const p = write(riff(chunk("fmt ", fmtBody(3, 2, 48000, 32)), chunk("data", data)));
      const a = readWav(p);
      expect(a.channels.length).toBe(2);
      expect(Array.from(a.channels[0])).toEqual([0.5, 0.25]);
      expect(Array.from(a.channels[1])).toEqual([-0.5, -0.25]);
    });

    it("reads 32-bit integer PCM", () => {
      const d32 = Buffer.alloc(8);
      d32.writeInt32LE(0x40000000, 0);
      d32.writeInt32LE(-0x40000000, 4);
      const a32 = readWav(write(riff(chunk("fmt ", fmtBody(1, 1, 48000, 32)), chunk("data", d32))));
      expect(Array.from(a32.channels[0])).toEqual([0.5, -0.5]);
    });

    it("reports the sample width of the file: 16, 24, 32-int and 32-float, and 64-float", () => {
      const bitsOf = (format: number, bits: number) =>
        readWav(write(riff(chunk("fmt ", fmtBody(format, 1, 48000, bits)), chunk("data", Buffer.alloc((bits / 8) * 2))))).bits;
      expect(bitsOf(1, 16)).toBe(16);
      expect(bitsOf(1, 24)).toBe(24);
      expect(bitsOf(1, 32)).toBe(32);
      expect(bitsOf(3, 32)).toBe(32);
      expect(bitsOf(3, 64)).toBe(64);
    });

    it("a file written by writeWav24 reads back as 24-bit", () => {
      const p = join(dir(), "w.wav");
      writeWav24(p, tone(440, 0.1));
      expect(readWav(p).bits).toBe(24);
    });

    it("throws a clear error for an unsupported audioFormat", () => {
      const p = write(riff(chunk("fmt ", fmtBody(2, 1, 48000, 4)), chunk("data", Buffer.alloc(8))));
      expect(() => readWav(p)).toThrow(/unsupported WAV audioFormat 2/);
    });

    it("throws when there is no data chunk", () => {
      const p = write(riff(chunk("fmt ", fmtBody(1, 1, 48000, 16))));
      expect(() => readWav(p)).toThrow(/no data chunk/);
    });
  });

  it("integratedLufs refuses a rate it cannot filter for, rather than mis-measuring", () => {
    for (const rate of [4000, 400000]) {
      expect(() => integratedLufs(tone(1000, 1, rate))).toThrow(/unsupported sample rate/);
    }
    expect(() => integratedLufs({ ...tone(1000, 1, 48000), sampleRate: 44100.5 })).toThrow(/unsupported sample rate/);
  });
});

describe("loudness at any sample rate", () => {
  // The standard publishes K-weighting coefficients for 48 kHz only. At other rates they are derived
  // from the same filter parameters, so the derivation is only trustworthy if it reproduces the
  // published values exactly at 48 kHz. This pins that.
  const PUBLISHED_48K = {
    stage1: { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] },
    stage2: { b: [1.0, -2.0, 1.0], a: [1, -1.99004745483398, 0.99007225036621] },
  };

  it("the derived filter reproduces the published 48 kHz coefficients", () => {
    const k = kWeighting(48000);
    for (const stage of ["stage1", "stage2"] as const) {
      for (const part of ["b", "a"] as const) {
        k[stage][part].forEach((v, i) => expect(Math.abs(v - PUBLISHED_48K[stage][part][i])).toBeLessThan(1e-12));
      }
    }
  });

  it("the filter changes with the rate (so 44.1 kHz is not just reusing the 48 kHz one)", () => {
    expect(kWeighting(44100).stage1.b[0]).not.toBeCloseTo(kWeighting(48000).stage1.b[0], 3);
  });

  it("a 1 kHz sine reads the same loudness at 44.1, 48, 88.2 and 96 kHz", () => {
    const amp = Math.pow(10, -20 / 20);
    for (const rate of [44100, 48000, 88200, 96000]) {
      expect(integratedLufs(tone(1000, 3, rate, amp, 2))).toBeCloseTo(-20, 1);   // the standard's calibration point
      expect(integratedLufs(tone(1000, 3, rate, amp, 1))).toBeCloseTo(-23, 1);
    }
  });

  it("the same signal at other frequencies agrees across rates too, not only at 1 kHz", () => {
    // Bass and treble are where a wrong filter shows. The same analogue tone, sampled two ways,
    // must read the same. Measured, 44.1 kHz sits within 0.005 LU of 48 kHz at every frequency from
    // 60 Hz to 16 kHz (a small constant offset from the bilinear transform). 0.02 LU is the bound:
    // four times what is seen, and far below anything that would move a gain.
    for (const f of [60, 250, 4000, 8000]) {
      const at48 = integratedLufs(tone(f, 3, 48000, 0.1, 2));
      const at441 = integratedLufs(tone(f, 3, 44100, 0.1, 2));
      expect(Math.abs(at441 - at48)).toBeLessThan(0.02);
    }
  });

  it("one gain lands a 44.1 kHz song on the target, like at 48 kHz", () => {
    const a = tone(1000, 3, 44100, 0.5);
    const g = gainFor(a, -18, -6);
    expect(integratedLufs(applyGain(a, g))).toBeCloseTo(-18, 1);
  });

  it("knows which rates it supports", () => {
    expect(isSupportedSampleRate(44100)).toBe(true);
    expect(isSupportedSampleRate(48000)).toBe(true);
    expect(isSupportedSampleRate(96000)).toBe(true);
    expect(isSupportedSampleRate(4000)).toBe(false);
    expect(isSupportedSampleRate(44100.5)).toBe(false);
    expect(isSupportedSampleRate(0)).toBe(false);
  });
});

describe("per-stem scores", () => {
  // residual = master - sum(stems), so a stem's part of the master is stem + residual.
  const scale = (a: Audio, g: number): Audio => ({ ...a, channels: a.channels.map((c) => c.map((v) => v * g)) });
  const diff = (a: Audio, b: Audio): Audio => ({ ...a, channels: a.channels.map((c, k) => c.map((v, i) => v - b.channels[k][i])) });
  /** `a` with everything outside [from, to) seconds zeroed. */
  const only = (a: Audio, from: number, to: number): Audio => ({
    ...a, channels: a.channels.map((c) => c.map((v, i) => (i >= from * a.sampleRate && i < to * a.sampleRate ? v : 0))),
  });
  const silent = (a: Audio): Audio => scale(a, 0);
  const opts = { windowSec: 2, tolerance: 0.02, mergeGapSec: 4, max: 3 };

  it("a stem the Master contains exactly scores 1", () => {
    const s = tone(220, 3);
    expect(stemScore(s, silent(s))).toBeCloseTo(1, 9);
  });

  it("a stem the Master holds at half its level scores 0.5", () => {
    const s = tone(220, 3);
    expect(stemScore(s, scale(s, -0.5))).toBeCloseTo(0.5, 9);
  });

  it("a stem whose Master version is something else entirely scores about 0", () => {
    const s = tone(220, 3);
    expect(Math.abs(stemScore(s, diff(tone(347, 3), s))!)).toBeLessThan(0.01);
  });

  it("a silent stem has no score", () => {
    expect(stemScore(silent(tone()), tone())).toBeNull();
  });

  it("finds the stretch where the stem is off", () => {
    const s = tone(220, 10);
    expect(offRanges(s, scale(only(s, 4, 6), -1), opts)).toEqual([{ start: 4, end: 6 }]);
  });

  it("merges stretches separated by a short gap", () => {
    const s = tone(220, 12);
    const r = sumAudio([only(s, 2, 4), only(s, 6, 8)]);
    expect(offRanges(s, scale(r, -1), opts)).toEqual([{ start: 2, end: 8 }]);
  });

  it("keeps stretches apart when the gap is longer than the merge gap", () => {
    const s = tone(220, 14);
    const r = sumAudio([only(s, 2, 4), only(s, 10, 12)]);
    expect(offRanges(s, scale(r, -1), opts)).toEqual([{ start: 2, end: 4 }, { start: 10, end: 12 }]);
  });

  it("ignores windows where the stem is silent, whatever the residual does there", () => {
    const s = only(tone(220, 10), 0, 6);
    expect(offRanges(s, only(tone(347, 10), 6, 10), opts)).toEqual([]);
  });

  it("a stem that is off by less than the tolerance has no off stretches", () => {
    const s = tone(220, 10);
    expect(offRanges(s, scale(s, -0.01), opts)).toEqual([]);
  });

  it("keeps the worst few stretches, listed in time order", () => {
    const s = tone(220, 40);
    // Four separate stretches, the one at 10 s the mildest.
    const r = sumAudio([scale(only(s, 0, 2), -0.9), scale(only(s, 10, 12), -0.1),
                        scale(only(s, 20, 22), -0.8), scale(only(s, 30, 32), -0.7)]);
    expect(offRanges(s, r, opts)).toEqual([{ start: 0, end: 2 }, { start: 20, end: 22 }, { start: 30, end: 32 }]);
  });

  it("the last window ends at the end of the audio, not past it", () => {
    const s = tone(220, 3);
    expect(offRanges(s, scale(s, -1), opts)).toEqual([{ start: 0, end: 3 }]);
  });
});
