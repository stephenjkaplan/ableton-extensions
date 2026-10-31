// Runs Analyze, Apply and Undo. Talks to Live only through LiveBridge and to the screen only through push.
import { DEFAULT_TARGET, makePlan, type Plan } from "./plan.js";
import { resolveRoles, type Role } from "./roles.js";
import { Store, type SavedAnswer, type SnapshotEntry } from "./store.js";
import type { ClipKey, LiveScan, Measure, SessionClip } from "./types.js";

export interface LiveBridge {
  scan(): Promise<LiveScan>;
  /** Resolves with the value Live reports afterwards. */
  setGain(trackIndex: number, slotIndex: number, raw: number): Promise<number>;
}

export interface ViewRow {
  key: ClipKey;
  name: string;
  trackName: string;
  role: Role;
  changeDb: number | null;
  unread: boolean;
  clamped: boolean;
}

export interface ViewState {
  phase: "idle" | "lanes" | "measuring" | "ready" | "busy";
  target: number;
  needsLanes: boolean;
  candidates: LiveScan["layerCandidates"];
  rows: ViewRow[];
  tracks: number;
  layers: number;
  needAnswer: ClipKey[];
  biggestDown: number;
  biggestUp: number;
  weakest: Plan["weakest"];
  canUndo: boolean;
  message: string;
  progress: { done: number; total: number } | null;
}

const MIN_CHANGE_DB = 0.01;
const READ_BACK_TOLERANCE = 1e-5;

const stillMeasures = (c: SessionClip, then: SessionClip) =>
  c.filePath === then.filePath && c.loopStart === then.loopStart && c.loopEnd === then.loopEnd;

const nameList = (names: string[]) => names.join(", ");

export class Controller {
  private scan: LiveScan | null = null;
  private store: Store | null = null;
  private measured = new Map<ClipKey, { clip: SessionClip; measure: Measure }>();
  private layerTracks: number[] | null = null;
  private answers: Record<ClipKey, SavedAnswer> = {};
  private target = DEFAULT_TARGET;
  private plan: Plan | null = null;
  private phase: ViewState["phase"] = "idle";
  private message = "";
  private progress: ViewState["progress"] = null;
  private busy = false;

  constructor(
    private readonly bridge: LiveBridge,
    private readonly baseDir: string,
    private readonly measure: (clip: SessionClip) => Promise<Measure>,
    private readonly push: (state: ViewState) => void,
  ) {}

  /** Finds the Set and whether it has anything to undo, so Undo works straight after a crash. */
  async start(): Promise<void> {
    await this.guarded("idle", async () => {
      this.adoptScan(await this.bridge.scan());
    });
  }

  async analyze(): Promise<void> {
    await this.guarded("measuring", async () => {
      this.adoptScan(await this.bridge.scan());
      this.message = "";
      this.plan = null;
      this.measured.clear();
      const saved = this.store?.loadAnswers() ?? { layerTracks: null, answers: {}, target: null };
      this.layerTracks = saved.layerTracks;
      this.answers = this.stillValid(saved.answers);
      this.target = saved.target ?? DEFAULT_TARGET;
      if (this.layerTracks === null) {
        this.phase = "lanes";
        return;
      }
      await this.measureAll();
    });
  }

  async setLayerTracks(tracks: number[]): Promise<void> {
    await this.guarded("measuring", async () => {
      this.layerTracks = tracks;
      this.save();
      await this.measureAll();
    });
  }

  setTarget(target: number): void {
    if (!Number.isFinite(target) || this.busy) return;
    this.target = target;
    this.message = "";
    this.save();
    this.replan();
  }

  matchWeakest(): void {
    if (this.plan?.weakest) this.setTarget(this.plan.weakest.matchTarget);
  }

  setRole(key: ClipKey, role: Role): void {
    const clip = this.scan?.session.find((c) => c.key === key);
    if (!clip || this.busy) return;
    const host = role.kind === "layer" && role.host !== null ? this.scan!.session.find((c) => c.key === role.host) : undefined;
    this.answers[key] = { role, filePath: clip.filePath, ...(host ? { hostFilePath: host.filePath } : {}) };
    this.message = "";
    this.save();
    this.replan();
  }

  async apply(): Promise<void> {
    const before = this.plan;
    if (!before) {
      this.say("Press Analyze first.");
      return;
    }
    await this.guarded("busy", async () => {
      const fresh = await this.bridge.scan();
      if (!fresh.setPath) {
        this.message = "Save the Set first. Undo needs to know which Set these changes belong to.";
        return;
      }
      this.adoptScan(fresh);
      const plan = this.planFor(fresh);

      const applied = new Set<ClipKey>();
      const writes = plan.rows.filter((r) => r.newRaw !== null && Math.abs(r.changeDb!) >= MIN_CHANGE_DB);
      const skipped = before.rows
        .filter((r) => r.changeDb !== null && !plan.rows.some((n) => n.key === r.key && n.changeDb !== null))
        .map((r) => r.name);
      if (writes.length === 0) {
        this.message = [`Nothing to change.`, this.skippedLine(skipped)].filter(Boolean).join(" ");
        this.plan = plan;
        return;
      }

      const clips = new Map(fresh.session.map((c) => [c.key, c]));
      const snapshot: SnapshotEntry[] = writes.map((r) => {
        const c = clips.get(r.key)!;
        return { key: c.key, trackIndex: c.trackIndex, slotIndex: c.slotIndex, filePath: c.filePath, rawGain: c.rawGain };
      });
      this.store!.pushSnapshot(snapshot);

      const off: string[] = [];
      try {
        for (const r of writes) {
          const c = clips.get(r.key)!;
          const got = await this.bridge.setGain(c.trackIndex, c.slotIndex, r.newRaw!);
          if (Math.abs(got - r.newRaw!) > READ_BACK_TOLERANCE) off.push(r.name);
          applied.add(r.key);
        }
      } catch (e) {
        this.message = `Apply stopped after ${applied.size} of ${writes.length} clips. Press Undo to put everything back. (${String(e)})`;
        return;
      }

      this.adoptScan(await this.bridge.scan());
      this.replanQuietly();
      this.message = [
        `Changed ${applied.size} clips. Press Undo to put them back.`,
        off.length ? `These didn't take: ${nameList(off)}.` : "",
        this.skippedLine(skipped),
      ].filter(Boolean).join(" ");
    });
  }

  async undo(): Promise<void> {
    await this.guarded("busy", async () => {
      const fresh = await this.bridge.scan();
      this.adoptScan(fresh);
      const snapshot = this.store?.latestSnapshot() ?? null;
      if (!snapshot) {
        this.message = "Nothing to undo.";
        return;
      }
      const clips = new Map(fresh.session.map((c) => [c.key, c]));
      const skipped: string[] = [];
      let restored = 0;
      let failed = false;
      try {
        for (const e of snapshot) {
          const c = clips.get(e.key);
          if (!c || c.filePath !== e.filePath) {
            skipped.push(e.filePath);
            continue;
          }
          const got = await this.bridge.setGain(e.trackIndex, e.slotIndex, e.rawGain);
          if (Math.abs(got - e.rawGain) > READ_BACK_TOLERANCE) failed = true;
          else restored++;
        }
      } catch {
        failed = true;
      }
      if (failed) {
        this.message = `Undo didn't finish. Press Undo again to retry. Restored ${restored} of ${snapshot.length} clips so far.`;
        return;
      }
      this.store!.dropLatestSnapshot();
      this.adoptScan(await this.bridge.scan());
      this.replanQuietly();
      this.message = [
        `Put back ${restored} clips.`,
        skipped.length ? `Left alone because they moved or changed: ${nameList(skipped)}.` : "",
      ].filter(Boolean).join(" ");
    });
  }

  private skippedLine(skipped: string[]): string {
    return skipped.length ? `Skipped because they moved or changed since Analyze: ${nameList(skipped)}.` : "";
  }

  private adoptScan(scan: LiveScan): void {
    this.scan = scan;
    this.store = scan.setPath ? new Store(this.baseDir, scan.setPath) : null;
  }

  private stillValid(saved: Record<ClipKey, SavedAnswer>): Record<ClipKey, SavedAnswer> {
    const files = new Map(this.scan!.session.map((c) => [c.key, c.filePath]));
    return Object.fromEntries(Object.entries(saved).filter(([key, a]) => {
      if (files.get(key) !== a.filePath) return false;
      return a.role.kind !== "layer" || a.role.host === null || files.get(a.role.host) === a.hostFilePath;
    }));
  }

  private async measureAll(): Promise<void> {
    const clips = this.scan!.session;
    this.phase = "measuring";
    for (let i = 0; i < clips.length; i++) {
      this.progress = { done: i, total: clips.length };
      this.emit();
      this.measured.set(clips[i].key, { clip: clips[i], measure: await this.measure(clips[i]) });
    }
    this.progress = { done: clips.length, total: clips.length };
    this.emit();
    this.progress = null;
    this.replanQuietly();
  }

  private planFor(scan: LiveScan): Plan {
    const roles = resolveRoles(scan, this.layerTracks ?? [], Object.fromEntries(
      Object.entries(this.answers).map(([key, a]) => [key, a.role]),
    ));
    const measures = new Map<ClipKey, Measure>();
    for (const c of scan.session) {
      const known = this.measured.get(c.key);
      if (known && stillMeasures(c, known.clip)) measures.set(c.key, known.measure);
    }
    return makePlan(scan.session, roles, measures, this.target);
  }

  private replanQuietly(): void {
    this.plan = this.scan && this.measured.size > 0 ? this.planFor(this.scan) : null;
  }

  private replan(): void {
    this.replanQuietly();
    this.emit();
  }

  private save(): void {
    this.store?.saveAnswers({ layerTracks: this.layerTracks, answers: this.answers, target: this.target });
  }

  private say(message: string): void {
    this.message = message;
    this.emit();
  }

  /** One thing at a time. Works out where it landed afterwards, and tells the screen either way. */
  private async guarded(phase: ViewState["phase"], work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.phase = phase;
    this.emit();
    try {
      await work();
    } catch (e) {
      this.message = `Something went wrong: ${String(e)}`;
    }
    this.busy = false;
    if (this.phase !== "lanes") this.phase = this.plan ? "ready" : "idle";
    this.emit();
  }

  private emit(): void {
    const clips = new Map(this.scan?.session.map((c) => [c.key, c]));
    const p = this.plan;
    this.push({
      phase: this.phase,
      target: this.target,
      needsLanes: this.phase === "lanes",
      candidates: this.scan?.layerCandidates ?? [],
      rows: (p?.rows ?? []).map((r) => ({
        key: r.key, name: r.name, trackName: clips.get(r.key)?.trackName ?? "", role: r.role,
        changeDb: r.changeDb, unread: r.unread, clamped: r.clamped,
      })),
      tracks: p?.tracks ?? 0,
      layers: p?.layers ?? 0,
      needAnswer: p?.needAnswer ?? [],
      biggestDown: p?.biggestDown ?? 0,
      biggestUp: p?.biggestUp ?? 0,
      weakest: p?.weakest ?? null,
      canUndo: (this.store?.latestSnapshot() ?? null) !== null,
      message: this.message,
      progress: this.progress,
    });
  }
}
