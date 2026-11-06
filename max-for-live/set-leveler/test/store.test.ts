import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
    expect(s.loadAnswers()).toEqual({ answers: {}, target: null });
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
    new Store(b, "/a.als").saveAnswers({ answers: {}, target: -13 });
    const other = new Store(b, "/b.als");
    expect(other.latestSnapshot()).toBeNull();
    expect(other.loadAnswers().target).toBeNull();
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
    s.saveAnswers({ answers, target: -12.5 });
    expect(s.loadAnswers()).toEqual({ answers, target: -12.5 });
  });
});

describe("Store snapshots, as files", () => {
  it("records which Set and when", () => {
    const s = new Store(base(), "/sets/a.als");
    s.pushSnapshot([entry(0.3)]);
    const info = s.latestSnapshotInfo()!;
    expect(info.setPath).toBe("/sets/a.als");
    expect(info.entries[0].rawGain).toBe(0.3);
    expect(Math.abs(info.createdAt - Date.now())).toBeLessThan(5000);
  });

  it("can narrow the latest snapshot to what's still to restore", () => {
    const s = new Store(base(), "/a.als");
    s.pushSnapshot([entry(0.1), { ...entry(0.2), key: "1:0", trackIndex: 1 }]);
    s.replaceLatestSnapshot([entry(0.1)]);
    expect(s.latestSnapshot()).toEqual([entry(0.1)]);
  });

  it("an unreadable snapshot reads as none instead of throwing", () => {
    const b = base();
    const s = new Store(b, "/a.als");
    s.pushSnapshot([entry(0.1)]);
    const [setDir] = readdirSync(b);
    writeFileSync(join(b, setDir, "snapshot-2.json"), "{ not json");
    expect(s.latestSnapshot()).toBeNull();
  });

  it("finds another Set's snapshot whose clips all match", () => {
    const b = base();
    new Store(b, "/sets/old.als").pushSnapshot([entry(0.3)]);
    const found = Store.findMatching(b, (e) => e.key === "0:0" && e.filePath === "a.wav");
    expect(found!.latestSnapshotInfo()!.setPath).toBe("/sets/old.als");
  });

  it("won't offer a snapshot if any clip doesn't match", () => {
    const b = base();
    new Store(b, "/sets/old.als").pushSnapshot([entry(0.3), { ...entry(0.2), key: "1:0" }]);
    expect(Store.findMatching(b, (e) => e.key === "0:0")).toBeNull();
  });

  it("offers the newest of several matches", async () => {
    const b = base();
    new Store(b, "/sets/older.als").pushSnapshot([entry(0.3)]);
    await new Promise((r) => setTimeout(r, 5));
    new Store(b, "/sets/newer.als").pushSnapshot([entry(0.4)]);
    expect(Store.findMatching(b, () => true)!.latestSnapshotInfo()!.setPath).toBe("/sets/newer.als");
  });

  it("finds nothing with no saved data at all", () => {
    expect(Store.findMatching(join(base(), "never-made"), () => true)).toBeNull();
  });
});
