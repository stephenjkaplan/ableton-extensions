import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGain, gainFor, integratedLufs, nullResidualDb, readWav, SumMismatch,
         sumAudio, truePeakDb, writeWav24, type Audio } from "../src/audio.js";

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

    it("throws a clear error for an unsupported audioFormat", () => {
      const p = write(riff(chunk("fmt ", fmtBody(2, 1, 48000, 4)), chunk("data", Buffer.alloc(8))));
      expect(() => readWav(p)).toThrow(/unsupported WAV audioFormat 2/);
    });

    it("throws when there is no data chunk", () => {
      const p = write(riff(chunk("fmt ", fmtBody(1, 1, 48000, 16))));
      expect(() => readWav(p)).toThrow(/no data chunk/);
    });
  });

  it("integratedLufs throws on a non-48 kHz buffer rather than mis-measuring", () => {
    const p = join(dir(), "r44.wav");
    writeWav24(p, tone(1000, 1, 44100));
    const a = readWav(p);
    expect(a.sampleRate).toBe(44100);
    expect(() => integratedLufs(a)).toThrow(/48 kHz/);
  });
});
