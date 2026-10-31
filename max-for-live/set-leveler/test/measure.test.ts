import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeWav24, type Audio } from "../../../extensions/stem-export/src/audio.js";
import { loadAudio, loudestStretch, measureClip, playedSeconds } from "../src/measure.js";
import type { SessionClip } from "../src/types.js";

function tone(freq = 1000, secs = 3, rate = 48000, amp = 0.1, chans = 2): Audio {
  const frames = Math.floor(secs * rate);
  const channels = Array.from({ length: chans }, () => {
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    return out;
  });
  return { channels, sampleRate: rate, frames };
}

function concat(a: Audio, b: Audio): Audio {
  const channels = a.channels.map((ch, i) => {
    const out = new Float64Array(ch.length + b.channels[i].length);
    out.set(ch);
    out.set(b.channels[i], ch.length);
    return out;
  });
  return { channels, sampleRate: a.sampleRate, frames: a.frames + b.frames };
}

function clip(over: Partial<SessionClip>): SessionClip {
  return { key: "0:0", trackIndex: 0, slotIndex: 0, trackName: "A", name: "c", filePath: "/nope.wav", rawGain: 0.4,
           warping: true, loopStart: 0, loopEnd: 8, warpMarkers: [{ beatTime: 0, sampleTime: 0 }, { beatTime: 8, sampleTime: 4 }], ...over };
}

const dir = () => mkdtempSync(join(tmpdir(), "sl-measure-"));

describe("loudestStretch", () => {
  it("reads a steady 0.1 amp stereo 1 kHz tone at -20, the standard reference (a stereo 1 kHz tone reads its own dBFS)", () => {
    expect(loudestStretch(tone(1000, 10, 48000, 0.1))).toBeCloseTo(-20, 1);
  });

  it("a long quiet intro doesn't read as quiet", () => {
    const a = concat(tone(1000, 25, 48000, 0.01), tone(1000, 5, 48000, 0.1));
    expect(loudestStretch(a)).toBeCloseTo(-20, 1);
  });

  it("reads a mono file as Live plays it, on both sides", () => {
    expect(loudestStretch(tone(1000, 10, 48000, 0.1, 1))).toBeCloseTo(loudestStretch(tone(1000, 10, 48000, 0.1, 2))!, 3);
  });

  it("silence reads null", () => expect(loudestStretch(tone(1000, 10, 48000, 0))).toBeNull());
  it("under 3 seconds reads null", () => expect(loudestStretch(tone(1000, 2))).toBeNull());
});

describe("playedSeconds", () => {
  it("maps beats to seconds through warp markers", () => {
    expect(playedSeconds(clip({ loopStart: 2, loopEnd: 6 }), 60)).toEqual({ start: 1, end: 3 });
  });

  it("extends past the outer markers", () => {
    expect(playedSeconds(clip({ loopStart: 8, loopEnd: 16 }), 60)).toEqual({ start: 4, end: 8 });
  });

  it("follows a tempo change between markers", () => {
    const warpMarkers = [{ beatTime: 0, sampleTime: 0 }, { beatTime: 4, sampleTime: 2 }, { beatTime: 8, sampleTime: 6 }];
    expect(playedSeconds(clip({ loopStart: 2, loopEnd: 6, warpMarkers }), 60)).toEqual({ start: 1, end: 4 });
  });

  it("measures the whole file for an unwarped clip", () => {
    expect(playedSeconds(clip({ warping: false, loopEnd: 20 }), 60)).toEqual({ start: 0, end: 60 });
  });

  it("measures the whole file with fewer than two markers", () => {
    expect(playedSeconds(clip({ warpMarkers: [{ beatTime: 0, sampleTime: 0 }] }), 60)).toEqual({ start: 0, end: 60 });
  });

  it("clamps the region to the file", () => {
    expect(playedSeconds(clip({ loopEnd: 400 }), 60).end).toBe(60);
    expect(playedSeconds(clip({ loopStart: -8, loopEnd: 8 }), 60).start).toBe(0);
  });
});

describe("measureClip", () => {
  it("measures only the part the clip plays", () => {
    const p = join(dir(), "a.wav");
    writeWav24(p, concat(tone(1000, 10, 48000, 0.01), tone(1000, 10, 48000, 0.1)));
    const warpMarkers = [{ beatTime: 0, sampleTime: 0 }, { beatTime: 2, sampleTime: 1 }];
    const quiet = measureClip(clip({ filePath: p, loopStart: 0, loopEnd: 18, warpMarkers }));
    const loud = measureClip(clip({ filePath: p, loopStart: 22, loopEnd: 38, warpMarkers }));
    expect(quiet.loudestLufs).toBeCloseTo(-40, 1);
    expect(loud.loudestLufs).toBeCloseTo(-20, 1);
    expect(quiet.peakDb).toBeCloseTo(-40, 0);
    expect(loud.peakDb).toBeCloseTo(-20, 0);
  });

  it("a missing file measures as nulls instead of throwing", () => {
    expect(measureClip(clip({ filePath: "/nope.wav" }))).toEqual({ loudestLufs: null, peakDb: null });
  });

  it("a silent clip has no peak reading", () => {
    const p = join(dir(), "s.wav");
    writeWav24(p, tone(1000, 10, 48000, 0));
    expect(measureClip(clip({ filePath: p, loopEnd: 18 }))).toEqual({ loudestLufs: null, peakDb: null });
  });
});

describe.skipIf(process.platform !== "darwin")("loadAudio", () => {
  it("decodes an m4a through afconvert", () => {
    const d = dir();
    writeWav24(join(d, "a.wav"), tone(1000, 5, 44100, 0.1));
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", join(d, "a.wav"), join(d, "a.m4a")]);
    const a = loadAudio(join(d, "a.m4a"));
    expect(a.sampleRate).toBe(44100);
    expect(loudestStretch(a)).toBeCloseTo(-20, 1);
  });

  it("throws on a file that isn't audio", () => {
    expect(() => loadAudio(join(dir(), "missing.m4a"))).toThrow();
  });
});
