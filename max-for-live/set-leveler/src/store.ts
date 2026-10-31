// Files for one Set: undo snapshots and saved answers. Lives outside the project, so it survives a crash.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./roles.js";
import type { ClipKey } from "./types.js";

export interface SnapshotEntry { key: ClipKey; trackIndex: number; slotIndex: number; filePath: string; rawGain: number }

/** An answer only holds while its slot, and its host's slot, still hold the same files. */
export interface SavedAnswer { role: Role; filePath: string; hostFilePath?: string }

export interface SavedAnswers { layerTracks: number[] | null; answers: Record<ClipKey, SavedAnswer>; target: number | null }

const SNAPSHOT = /^snapshot-(\d+)\.json$/;

export class Store {
  private readonly dir: string;

  constructor(baseDir: string, setPath: string) {
    this.dir = join(baseDir, createHash("sha1").update(setPath).digest("hex"));
    mkdirSync(this.dir, { recursive: true });
  }

  private write(name: string, data: unknown): void {
    const temp = join(this.dir, `${name}.tmp`);
    writeFileSync(temp, JSON.stringify(data, null, 1));
    renameSync(temp, join(this.dir, name));
  }

  private snapshotNumbers(): number[] {
    return readdirSync(this.dir).flatMap((f) => {
      const m = SNAPSHOT.exec(f);
      return m ? [Number(m[1])] : [];
    }).sort((a, b) => a - b);
  }

  pushSnapshot(entries: SnapshotEntry[]): void {
    const latest = this.snapshotNumbers().at(-1) ?? 0;
    this.write(`snapshot-${latest + 1}.json`, entries);
  }

  latestSnapshot(): SnapshotEntry[] | null {
    const latest = this.snapshotNumbers().at(-1);
    if (latest === undefined) return null;
    return JSON.parse(readFileSync(join(this.dir, `snapshot-${latest}.json`), "utf8")) as SnapshotEntry[];
  }

  dropLatestSnapshot(): void {
    const latest = this.snapshotNumbers().at(-1);
    if (latest !== undefined) rmSync(join(this.dir, `snapshot-${latest}.json`));
  }

  loadAnswers(): SavedAnswers {
    try {
      return JSON.parse(readFileSync(join(this.dir, "answers.json"), "utf8")) as SavedAnswers;
    } catch {
      return { layerTracks: null, answers: {}, target: null };
    }
  }

  saveAnswers(saved: SavedAnswers): void {
    this.write("answers.json", saved);
  }
}
