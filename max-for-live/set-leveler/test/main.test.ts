import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { writeWav24, type Audio } from "../../../extensions/stem-export/src/audio.js";
import type { ViewState } from "../src/controller.js";
import { rawToDb } from "../src/gain-map.js";
import { deliver, sent } from "./fake-max-api.js";

// The whole device minus Max: messages in and out exactly as bridge.js and ui.html send them.
const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const settle = () => new Promise((r) => setTimeout(r, 20));
const ui = (action: string, extra: object = {}) => deliver("ui", enc({ action, ...extra }));

function tone(amp: number, secs = 6): Audio {
  const frames = secs * 48000;
  const ch = new Float64Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  return { channels: [ch, ch], sampleRate: 48000, frames };
}

const live = new Map<string, Record<string, unknown>>();

/** Plays the part of bridge.js for whatever has been sent since the last call. */
function answerLive() {
  for (const m of sent.splice(0)) {
    if (m[0] === "to_web" && m[1] === "state_part") {
      parts[m[2] as number] = m[4] as string;
      if ((m[2] as number) === (m[3] as number) - 1) state = JSON.parse(decodeURIComponent(parts.join("")));
    }
    if (m[0] === "to_live" && m[1] === "scan") {
      for (const c of live.values()) deliver("clip", enc(c));
      deliver("arr", enc({ filePath: files.vox, start: 0, end: 8 }));
      deliver("arr", enc({ filePath: files.loud, start: 0, end: 8 }));
      deliver("scan_done", enc({ setPath: "/sets/Test.als" }));
    }
    if (m[0] === "to_live" && m[1] === "setgain") {
      const [, , trackIndex, slotIndex, value] = m as [string, string, number, number, number];
      live.get(`${trackIndex}:${slotIndex}`)!.rawGain = value;
      deliver("gain_set", enc({ trackIndex, slotIndex, value }));
    }
  }
}

async function drain() {
  for (let i = 0; i < 12; i++) {
    answerLive();
    await settle();
  }
}

let parts: string[] = [];
let state: ViewState;
const files = { loud: "", vox: "" };

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), "sl-main-"));
  process.env.HOME = d;
  files.loud = join(d, "loud.wav");
  files.vox = join(d, "vox.wav");
  writeWav24(files.loud, tone(0.5));
  writeWav24(files.vox, tone(0.1));
  const base = { warping: true, loopStart: 0, loopEnd: 8, rawGain: 0.4, warpMarkers: [{ beatTime: 0, sampleTime: 0 }, { beatTime: 8, sampleTime: 4 }] };
  live.set("0:0", { ...base, key: "0:0", trackIndex: 0, slotIndex: 0, trackName: "TRACK A", name: "LOUD", filePath: files.loud });
  live.set("3:0", { ...base, key: "3:0", trackIndex: 3, slotIndex: 0, trackName: "TRACK C", name: "VOX", filePath: files.vox });
  await import("../src/main.js");
});

describe("the device, end to end", () => {
  it("asks Max to load its page", () => {
    const m = sent.find((x) => x[0] === "to_web" && x[1] === "readfile");
    expect(String(m?.[2])).toMatch(/ui\.html$/);
  });

  it("finds the Set when the page is ready", async () => {
    ui("ready");
    await drain();
    expect(state.canUndo).toBe(false);
    expect(state.phase).toBe("idle");
  });

  it("Analyze asks about lanes, then measures", async () => {
    ui("analyze");
    await drain();
    expect(state.needsLanes).toBe(true);
    expect(state.candidates).toEqual([{ trackIndex: 0, trackName: "TRACK A" }, { trackIndex: 3, trackName: "TRACK C" }]);
    ui("lanes", { tracks: [3] });
    await drain();
    expect(state.phase).toBe("ready");
    expect(state.tracks).toBe(1);
    expect(state.layers).toBe(1);
    expect(state.rows.find((r) => r.key === "3:0")!.role).toEqual({ kind: "layer", host: "0:0" });
  });

  it("the plan comes from the real audio", () => {
    // A 0.5 amp stereo 1 kHz tone reads -6 LUFS, so -12 is 6 dB down.
    expect(state.rows.find((r) => r.key === "0:0")!.changeDb).toBeCloseTo(-6, 0);
  });

  it("Apply writes gains and Undo puts them back exactly", async () => {
    ui("apply");
    await drain();
    expect(rawToDb(live.get("0:0")!.rawGain as number)).toBeCloseTo(-6, 0);
    expect(rawToDb(live.get("3:0")!.rawGain as number)).toBeCloseTo(-6, 0);
    expect(state.canUndo).toBe(true);
    ui("undo");
    await drain();
    expect(live.get("0:0")!.rawGain).toBe(0.4);
    expect(live.get("3:0")!.rawGain).toBe(0.4);
    expect(state.canUndo).toBe(false);
  });

  it("role and target changes reach the plan", async () => {
    ui("target", { target: -14 });
    await drain();
    expect(state.target).toBe(-14);
    ui("role", { key: "3:0", role: { kind: "leave" } });
    await drain();
    expect(state.rows.find((r) => r.key === "3:0")!.changeDb).toBeNull();
  });

  it("a page that's sent a long state still gets all of it", async () => {
    const name = "x".repeat(9000);
    live.get("0:0")!.name = name;
    ui("analyze");
    await drain();
    expect(state.rows.find((r) => r.key === "0:0")!.name).toBe(name);
  });
});
