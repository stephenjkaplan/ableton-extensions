// Files for one Set: undo snapshots and saved answers. Lives outside the project, so it survives a crash.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./roles.js";
import type { ClipKey } from "./types.js";

export interface SnapshotEntry { key: ClipKey; trackIndex: number; slotIndex: number; filePath: string; rawGain: number }

/** An answer only holds while its slot, and its host's slot, still hold the same files. */
export interface SavedAnswer { role: Role; filePath: string; hostFilePath?: string }

export interface SavedAnswers {
  answers: Record<ClipKey, SavedAnswer>;
  target: number | null;
}

export interface SnapshotInfo { setPath: string; createdAt: number; entries: SnapshotEntry[] }

const SNAPSHOT = /^snapshot-(\d+)\.json$/;

function snapshotNumbers(dir: string): number[] {
  return readdirSync(dir).flatMap((f) => {
    const m = SNAPSHOT.exec(f);
    return m ? [Number(m[1])] : [];
  }).sort((a, b) => a - b);
}

/** Null if there's none, or the newest can't be read: never guess at gains. */
function readLatest(dir: string): SnapshotInfo | null {
  const latest = snapshotNumbers(dir).at(-1);
  if (latest === undefined) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `snapshot-${latest}.json`), "utf8")) as SnapshotInfo;
  } catch {
    return null;
  }
}

export class Store {
  private readonly dir: string;
  private readonly setPath: string;

  constructor(baseDir: string, setPath: string) {
    this.dir = join(baseDir, createHash("sha1").update(setPath).digest("hex"));
    this.setPath = setPath;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * After Save As, a Set's path has changed but its clips haven't. This finds the newest Set whose latest
   * snapshot matches clip for clip, so its Undo isn't stranded under the old path.
   */
  static findMatching(baseDir: string, matches: (entry: SnapshotEntry) => boolean): Store | null {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(baseDir);
    } catch {
      return null;
    }
    let best: SnapshotInfo | null = null;
    for (const d of dirs) {
      const info = readLatest(join(baseDir, d));
      if (info && info.entries.length > 0 && info.entries.every(matches) && (!best || info.createdAt > best.createdAt)) best = info;
    }
    return best && new Store(baseDir, best.setPath);
  }

  private write(name: string, data: unknown): void {
    const temp = join(this.dir, `${name}.tmp`);
    writeFileSync(temp, JSON.stringify(data, null, 1));
    renameSync(temp, join(this.dir, name));
  }


  pushSnapshot(entries: SnapshotEntry[]): void {
    const latest = snapshotNumbers(this.dir).at(-1) ?? 0;
    const info: SnapshotInfo = { setPath: this.setPath, createdAt: Date.now(), entries };
    this.write(`snapshot-${latest + 1}.json`, info);
  }

  latestSnapshotInfo(): SnapshotInfo | null {
    return readLatest(this.dir);
  }

  latestSnapshot(): SnapshotEntry[] | null {
    return this.latestSnapshotInfo()?.entries ?? null;
  }

  /** Keeps only what's still to restore, so Undo can finish later. */
  replaceLatestSnapshot(entries: SnapshotEntry[]): void {
    const latest = snapshotNumbers(this.dir).at(-1);
    const info = this.latestSnapshotInfo();
    if (latest !== undefined && info) this.write(`snapshot-${latest}.json`, { ...info, entries });
  }

  dropLatestSnapshot(): void {
    const latest = snapshotNumbers(this.dir).at(-1);
    if (latest !== undefined) rmSync(join(this.dir, `snapshot-${latest}.json`));
  }

  loadAnswers(): SavedAnswers {
    try {
      return JSON.parse(readFileSync(join(this.dir, "answers.json"), "utf8")) as SavedAnswers;
    } catch {
      return { answers: {}, target: null };
    }
  }

  saveAnswers(saved: SavedAnswers): void {
    this.write("answers.json", saved);
  }
}
