import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
  it("round-trips a wav through disk", () => {
    const p = join(dir(), "a.wav");
    const a = tone();
    writeWav24(p, a);
    const b = readWav(p);
    expect(b.sampleRate).toBe(48000);
    expect(b.frames).toBe(a.frames);
    expect(b.channels[0][1000]).toBeCloseTo(a.channels[0][1000], 4);
  });

  it("sums sample-accurately", () => {
    const a = tone(220), b = tone(660);
    const s = sumAudio([a, b]);
    expect(s.channels[0][500]).toBeCloseTo(a.channels[0][500] + b.channels[0][500], 10);
  });

  it("rejects a sample-rate mismatch", () => {
    // Review Focus 4: silently resampling would make the null test lie.
    expect(() => sumAudio([tone(440, 1, 48000), tone(440, 1, 44100)])).toThrow(SumMismatch);
  });

  it("rejects a length mismatch", () => {
    expect(() => sumAudio([tone(440, 2), tone(440, 1.5)])).toThrow(SumMismatch);
  });

  it("rejects a channel-count mismatch", () => {
    expect(() => sumAudio([tone(440, 1, 48000, 0.1, 2), tone(440, 1, 48000, 0.1, 1)]))
      .toThrow(SumMismatch);
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
    const quiet = tone(1000, 3, 48000, 0.001);
    const g = gainFor(quiet, -18, -6);
    expect(truePeakDb(applyGain(quiet, g))).toBeLessThanOrEqual(-6 + 0.01);
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
});
