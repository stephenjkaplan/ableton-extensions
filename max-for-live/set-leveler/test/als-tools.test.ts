import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const TOOL = "scripts/als-tools.py";

function als(path: string, gains: [number, number], arrangementGain = 1): string {
  const slot = (gain: number) => `<ClipSlot><ClipSlot><Value><AudioClip Time="0"><Name Value="c"/><SampleVolume Value="${gain}"/>
    <SampleRef><FileRef><Path Value="/a.wav"/></FileRef></SampleRef></AudioClip></Value></ClipSlot></ClipSlot>`;
  const xml = `<Ableton><LiveSet><Tracks><AudioTrack Id="1"><Name><EffectiveName Value="TRACK A"/></Name>
    <DeviceChain><MainSequencer><ClipSlotList>${gains.map(slot).join("")}</ClipSlotList>
    <ClipTimeable><ArrangerAutomation><Events><AudioClip Time="4"><Name Value="arr"/><SampleVolume Value="${arrangementGain}"/>
    <SampleRef><FileRef><Path Value="/a.wav"/></FileRef></SampleRef></AudioClip></Events></ArrangerAutomation></ClipTimeable>
    </MainSequencer></DeviceChain></AudioTrack></Tracks></LiveSet></Ableton>`;
  writeFileSync(path, gzipSync(xml));
  return path;
}

const compare = (a: string, b: string) => spawnSync("python3", ["-I", TOOL, "compare", a, b], { encoding: "utf8" });

describe("als-tools compare", () => {
  const d = mkdtempSync(join(tmpdir(), "sl-als-"));

  it("passes on two identical Sets", () => {
    const r = compare(als(join(d, "a.als"), [1, 0.5]), als(join(d, "b.als"), [1, 0.5]));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 clips differ");
  });

  it("fails and names a Session clip whose gain changed", () => {
    const r = compare(als(join(d, "a.als"), [1, 0.5]), als(join(d, "c.als"), [1, 0.6]));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("TRACK A");
    expect(r.stdout).toContain("slot 1");
    expect(r.stdout).toContain("1 clips differ");
  });

  it("notices a change in Arrangement, which the device should never touch", () => {
    const r = compare(als(join(d, "a.als"), [1, 0.5]), als(join(d, "e.als"), [1, 0.5], 0.7));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("arrangement");
  });

  it("fails if clips were added or removed", () => {
    const b = join(d, "f.als");
    const xml = `<Ableton><LiveSet><Tracks></Tracks></LiveSet></Ableton>`;
    writeFileSync(b, gzipSync(xml));
    expect(compare(als(join(d, "a.als"), [1, 0.5]), b).status).toBe(1);
  });

  it("never writes to the Sets it reads", () => {
    const path = als(join(d, "g.als"), [1, 0.5]);
    const before = execFileSync("shasum", [path]).toString();
    compare(path, path);
    expect(execFileSync("shasum", [path]).toString()).toBe(before);
  });
});
