// Runs Analyze, Apply and Undo. Talks to Live only through LiveBridge and to the screen only through push.
import { basename } from "node:path";
import { DEFAULT_TARGET, makePlan, type Plan } from "./plan.js";
import { resolveRoles, type Role } from "./roles.js";
import { Store, type SavedAnswer, type SnapshotEntry } from "./store.js";
import type { ClipKey, LiveScan, Measure, SessionClip } from "./types.js";

export interface LiveBridge {
  /** Reading a large Set takes seconds, so it reports tracks done as it goes. */
  scan(onProgress?: (done: number, total: number) => void): Promise<LiveScan>;
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
  phase: "idle" | "measuring" | "ready" | "busy";
  target: number;
  rows: ViewRow[];
  tracks: number;
  layers: number;
  needAnswer: ClipKey[];
  biggestDown: number;
  biggestUp: number;
  weakest: Plan["weakest"];
  headline: string;
  detail: string;
  canUndo: boolean;
  undoLabel: string;
  message: string;
  progress: { label: string; done: number; total: number; unit: string } | null;
}

const MIN_CHANGE_DB = 0.01;
const READ_BACK_TOLERANCE = 1e-5;
const MIN_TARGET = -36;
const MAX_TARGET = -4;

const stillMeasures = (c: SessionClip, then: SessionClip) =>
  c.filePath === then.filePath && c.loopStart === then.loopStart && c.loopEnd === then.loopEnd;

const nameList = (names: string[]) => names.join(", ");
const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class Controller {
  private scan: LiveScan | null = null;
  private analyzed: LiveScan | null = null; // roles come from this, so a later change can't turn a layer into a track
  private store: Store | null = null;
  private measured = new Map<ClipKey, { clip: SessionClip; measure: Measure }>();
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
      this.adoptScan(await this.readSet());
      this.loadSaved();
    });
  }

  async analyze(): Promise<void> {
    await this.guarded("measuring", async () => {
      this.adoptScan(await this.readSet());
      this.analyzed = this.scan;
      this.message = "";
      this.plan = null;
      this.measured.clear();
      this.loadSaved();
      await this.measureAll();
    });
  }

  setTarget(target: number): void {
    if (this.busy) return;
    if (!Number.isFinite(target) || target < MIN_TARGET || target > MAX_TARGET) {
      this.emit(); // puts the field back
      return;
    }
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
      const fresh = await this.readSet();
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
          this.show("Applying", applied.size, writes.length, "clips");
          const c = clips.get(r.key)!;
          const got = await this.bridge.setGain(c.trackIndex, c.slotIndex, r.newRaw!);
          c.rawGain = got;
          if (Math.abs(got - r.newRaw!) > READ_BACK_TOLERANCE) off.push(r.name);
          applied.add(r.key);
        }
      } catch (e) {
        this.progress = null;
        this.message = `Apply stopped after ${applied.size} of ${writes.length} clips. Press Undo to put everything back. (${String(e)})`;
        return;
      }

      this.progress = null;
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
      const fresh = await this.readSet();
      this.adoptScan(fresh);
      const store = this.undoStore();
      const snapshot = store?.latestSnapshot() ?? null;
      if (!store || !snapshot) {
        this.message = "Nothing to undo.";
        return;
      }
      const clips = new Map(fresh.session.map((c) => [c.key, c]));
      const remaining: SnapshotEntry[] = [];
      const moved: string[] = [];
      let failed = 0;
      for (let i = 0; i < snapshot.length; i++) {
        const e = snapshot[i];
        this.show("Putting back", i, snapshot.length, "clips");
        if (clips.get(e.key)?.filePath !== e.filePath) {
          moved.push(e.filePath);
          remaining.push(e);
          continue;
        }
        try {
          const got = await this.bridge.setGain(e.trackIndex, e.slotIndex, e.rawGain);
          clips.get(e.key)!.rawGain = got;
          if (Math.abs(got - e.rawGain) > READ_BACK_TOLERANCE) throw new Error("read back differs");
        } catch {
          failed++;
          remaining.push(e);
        }
      }
      if (remaining.length === 0) store.dropLatestSnapshot();
      else store.replaceLatestSnapshot(remaining);

      this.progress = null;
      this.replanQuietly();
      const restored = snapshot.length - remaining.length;
      this.message = [
        `Put back ${restored} of ${plural(snapshot.length, "clip")}.`,
        moved.length ? `These moved or changed, so they weren't touched: ${nameList(moved)}. Put them back where they were and press Undo to finish.` : "",
        failed ? `${plural(failed, "clip")} didn't take. Press Undo again to retry.` : "",
      ].filter(Boolean).join(" ");
    });
  }

  private async readSet(): Promise<LiveScan> {
    this.show("Reading the Set", 0, 1, "tracks");
    const scan = await this.bridge.scan((done, total) => this.show("Reading the Set", done, total, "tracks"));
    this.progress = null;
    return scan;
  }

  private show(label: string, done: number, total: number, unit: string): void {
    this.progress = { label, done, total, unit };
    this.emit();
  }

  /** This Set's snapshots, or after Save As, the snapshot of the Set whose clips match this one exactly. */
  private undoStore(): Store | null {
    if (this.store?.latestSnapshotInfo()) return this.store;
    if (!this.scan) return null;
    const clips = new Map(this.scan.session.map((c) => [c.key, c]));
    return Store.findMatching(this.baseDir, (e) => clips.get(e.key)?.filePath === e.filePath);
  }

  private loadSaved(): void {
    if (!this.store || !this.scan) return;
    const saved = this.store.loadAnswers();
    this.answers = this.stillValid(saved.answers);
    this.target = saved.target ?? DEFAULT_TARGET;
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
      this.show("Measuring", i, clips.length, "clips");
      this.measured.set(clips[i].key, { clip: clips[i], measure: await this.measure(clips[i]) });
    }
    this.show("Measuring", clips.length, clips.length, "clips");
    this.progress = null;
    this.replanQuietly();
  }

  private planFor(scan: LiveScan): Plan {
    const roles = resolveRoles(this.analyzed ?? scan, Object.fromEntries(
      Object.entries(this.answers).map(([key, a]) => [key, a.role]),
    ));
    const measures = new Map<ClipKey, Measure>();
    for (const c of scan.session) {
      const known = this.measured.get(c.key);
      if (known && stillMeasures(c, known.clip)) measures.set(c.key, known.measure);
      else roles.set(c.key, { kind: "leave" }); // not what was analyzed, so nothing touches it until Analyze
    }
    for (const [key, role] of roles) {
      if (role.kind === "layer" && role.host !== null && roles.get(role.host)?.kind !== "track") roles.set(key, { kind: "layer", host: null });
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
    this.store?.saveAnswers({ answers: this.answers, target: this.target });
  }

  private summary(p: Plan | null): { headline: string; detail: string } {
    if (!p) return { headline: "", detail: "" };
    if (p.rows.length === 0) return { headline: "No audio clips in Session view.", detail: "" };
    const unread = p.rows.filter((r) => r.unread).length;
    if (p.tracks === 0 && unread > 0) {
      return { headline: "Couldn't read any tracks.", detail: "Check that their files are online, then press Analyze." };
    }
    const moving = p.biggestDown < -0.05 || p.biggestUp > 0.05;
    return {
      headline: moving ? `${plural(p.tracks, "track")} and ${plural(p.layers, "layer")} ready to level.` : "Everything's already at the target.",
      detail: [
        moving ? `Biggest changes: ${fmtDb(p.biggestDown)} and ${fmtDb(p.biggestUp)}.` : "",
        unread ? `${plural(unread, "track")} had no reading, so ${unread === 1 ? "it stays" : "they stay"} as ${unread === 1 ? "it is" : "they are"}.` : "",
      ].filter(Boolean).join(" "),
    };
  }

  private undoLabel(store: Store | null): string {
    const info = store?.latestSnapshotInfo();
    if (!info) return "";
    const when = new Date(info.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const from = info.setPath === this.scan?.setPath ? "" : `, from ${basename(info.setPath)}`;
    return `Undo puts back ${plural(info.entries.length, "clip")} (${when}${from})`;
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
    this.progress = null;
    this.busy = false;
    this.phase = this.plan ? "ready" : "idle";
    this.emit();
  }

  private emit(): void {
    const clips = new Map(this.scan?.session.map((c) => [c.key, c]));
    const p = this.plan;
    const undoFrom = this.undoStore();
    this.push({
      phase: this.phase,
      target: this.target,
      rows: (this.progress ? [] : p?.rows ?? []).map((r) => ({
        key: r.key, name: r.name, trackName: clips.get(r.key)?.trackName ?? "", role: r.role,
        changeDb: r.changeDb, unread: r.unread, clamped: r.clamped,
      })),
      tracks: p?.tracks ?? 0,
      layers: p?.layers ?? 0,
      needAnswer: p?.needAnswer ?? [],
      biggestDown: p?.biggestDown ?? 0,
      biggestUp: p?.biggestUp ?? 0,
      weakest: p?.weakest ?? null,
      ...this.summary(p),
      canUndo: undoFrom !== null,
      undoLabel: this.undoLabel(undoFrom),
      message: this.message,
      progress: this.progress,
    });
  }
}
