import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type SnapshotEntry } from "../src/store.js";

const base = () => mkdtempSync(join(tmpdir(), "sl-store-"));
const entry = (rawGain: number): SnapshotEntry => ({ key: "0:0", trackIndex: 0, slotIndex: 0, filePath: "a.wav", rawGain });

describe("Store", () => {
  it("starts with nothing", () => {
    const s = new Store(base(), "/a.als");
    expect(s.latestSnapshot()).toBeNull();
    expect(s.loadAnswers()).toEqual({ layerTracks: null, answers: {}, target: null });
  });

  it("keeps exact raw gains", () => {
    const s = new Store(base(), "/a.als");
    s.pushSnapshot([entry(0.4000000059604645)]);
    expect(s.latestSnapshot()![0].rawGain).toBe(0.4000000059604645);
  });

  it("steps back through snapshots, newest first", () => {
    const s = new Store(base(), "/a.als");
    s.pushSnapshot([entry(0.1)]);
    s.pushSnapshot([entry(0.2)]);
    expect(s.latestSnapshot()![0].rawGain).toBe(0.2);
    s.dropLatestSnapshot();
    expect(s.latestSnapshot()![0].rawGain).toBe(0.1);
    s.dropLatestSnapshot();
    expect(s.latestSnapshot()).toBeNull();
  });

  it("keeps order past nine snapshots", () => {
    const s = new Store(base(), "/a.als");
    for (let i = 0; i < 12; i++) s.pushSnapshot([entry(i)]);
    expect(s.latestSnapshot()![0].rawGain).toBe(11);
  });

  it("survives a new Store for the same Set", () => {
    const b = base();
    new Store(b, "/a.als").pushSnapshot([entry(0.3)]);
    expect(new Store(b, "/a.als").latestSnapshot()![0].rawGain).toBe(0.3);
  });

  it("gives each Set its own files", () => {
    const b = base();
    new Store(b, "/a.als").pushSnapshot([entry(0.3)]);
    new Store(b, "/a.als").saveAnswers({ layerTracks: [3], answers: {}, target: -13 });
    const other = new Store(b, "/b.als");
    expect(other.latestSnapshot()).toBeNull();
    expect(other.loadAnswers().layerTracks).toBeNull();
  });

  it("leaves no temp files behind", () => {
    const b = base();
    new Store(b, "/a.als").pushSnapshot([entry(0.3)]);
    const [setDir] = readdirSync(b);
    expect(readdirSync(join(b, setDir)).every((f) => f.endsWith(".json"))).toBe(true);
  });

  it("round-trips answers", () => {
    const s = new Store(base(), "/a.als");
    const answers = { "3:1": { role: { kind: "layer" as const, host: "0:2" }, filePath: "v.wav", hostFilePath: "a.wav" } };
    s.saveAnswers({ layerTracks: [3], answers, target: -12.5 });
    expect(s.loadAnswers()).toEqual({ layerTracks: [3], answers, target: -12.5 });
  });
});
