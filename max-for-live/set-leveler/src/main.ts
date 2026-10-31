// Entry point inside node.script: joins Max's messages to the Controller, and the Controller to the screen.
import { homedir } from "node:os";
import { join } from "node:path";
import Max from "max-api";
import { Controller, type LiveBridge, type ViewState } from "./controller.js";
import { measureClip } from "./measure.js";
import type { ArrangementClip, LiveScan, SessionClip } from "./types.js";

const BASE_DIR = join(homedir(), "Library", "Application Support", "Set Leveler");
const SCAN_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 10_000;
const CHUNK = 4000;

// Node for Max rejects an outlet with no reply within 3 s, and an unhandled rejection ends the script. A long
// measurement can cause that while the message itself still arrives, so it isn't an error here.
const ignoreSlowReply = () => {};
const toLive = (...args: unknown[]) => Max.outlet("to_live", ...args).catch(ignoreSlowReply);
const toWeb = (...args: unknown[]) => Max.outlet("to_web", ...args).catch(ignoreSlowReply);
const decode = <T>(s: string): T => JSON.parse(decodeURIComponent(s)) as T;

let scanning: {
  session: SessionClip[];
  arrangement: ArrangementClip[];
  resolve: (s: LiveScan) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (done: number, total: number) => void;
} | null = null;

function scanTimer(reject: (e: Error) => void): NodeJS.Timeout {
  return setTimeout(() => {
    scanning = null;
    reject(new Error("Live didn't answer the scan"));
  }, SCAN_TIMEOUT_MS);
}
const writes = new Map<string, { resolve: (v: number) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

const bridge: LiveBridge = {
  scan: (onProgress) => new Promise<LiveScan>((resolve, reject) => {
    scanning = { session: [], arrangement: [], resolve, reject, timer: scanTimer(reject), onProgress };
    void toLive("scan");
  }),
  setGain: (trackIndex, slotIndex, raw) => new Promise<number>((resolve, reject) => {
    const key = `${trackIndex}:${slotIndex}`;
    const timer = setTimeout(() => {
      writes.delete(key);
      reject(new Error(`Live didn't answer the write to ${key}`));
    }, WRITE_TIMEOUT_MS);
    writes.set(key, { resolve, reject, timer });
    void toLive("setgain", trackIndex, slotIndex, raw);
  }),
};

Max.addHandler("clip", (s: string) => { scanning?.session.push(decode<SessionClip>(s)); });
Max.addHandler("arr", (s: string) => { scanning?.arrangement.push(decode<ArrangementClip>(s)); });
Max.addHandler("scan_progress", (s: string) => {
  if (!scanning) return;
  clearTimeout(scanning.timer); // the timeout is for silence, not for a large Set
  scanning.timer = scanTimer(scanning.reject);
  const { done, total } = decode<{ done: number; total: number }>(s);
  scanning.onProgress?.(done, total);
});
Max.addHandler("scan_done", (s: string) => {
  if (!scanning) return;
  const { session, arrangement, resolve, timer } = scanning;
  scanning = null;
  clearTimeout(timer);
  const names = new Map(session.map((c) => [c.trackIndex, c.trackName]));
  const layerCandidates = [...names].map(([trackIndex, trackName]) => ({ trackIndex, trackName }));
  resolve({ setPath: decode<{ setPath: string }>(s).setPath, session, arrangement, layerCandidates });
});
Max.addHandler("bridge_error", (s: string) => {
  if (!scanning) return;
  const { reject, timer } = scanning;
  scanning = null;
  clearTimeout(timer);
  reject(new Error(decode<string>(s)));
});
Max.addHandler("gain_set", (s: string) => {
  const r = decode<{ trackIndex: number; slotIndex: number; value: number | null; error?: string }>(s);
  const key = `${r.trackIndex}:${r.slotIndex}`;
  const pending = writes.get(key);
  if (!pending) return;
  writes.delete(key);
  clearTimeout(pending.timer);
  if (r.value === null) pending.reject(new Error(r.error ?? `no clip at ${key}`));
  else pending.resolve(r.value);
});

let last: ViewState | null = null;
function show(state: ViewState): void {
  last = state;
  const body = encodeURIComponent(JSON.stringify(state));
  const parts = Math.ceil(body.length / CHUNK);
  for (let i = 0; i < parts; i++) void toWeb("state_part", i, parts, body.slice(i * CHUNK, (i + 1) * CHUNK));
}

const measure = async (clip: SessionClip) => {
  await new Promise((resolve) => setImmediate(resolve)); // lets messages through between files
  return measureClip(clip);
};
const controller = new Controller(bridge, BASE_DIR, measure, show);

let pageReady = false;
let started = false;
const loadPage = () => toWeb("readfile", join(__dirname, "ui.html"));

interface UiAction { action: string; tracks?: number[]; target?: number; key?: string; role?: Parameters<Controller["setRole"]>[1] }

Max.addHandler("opened", () => { if (!pageReady) void loadPage(); });
Max.addHandler("ui", (s: string) => {
  const a = decode<UiAction>(s);
  switch (a.action) {
    case "ready":
      pageReady = true;
      if (last) show(last);
      if (!started) { started = true; void controller.start(); }
      break;
    case "analyze": void controller.analyze(); break;
    case "lanes": void controller.setLayerTracks(a.tracks ?? []); break;
    case "target": controller.setTarget(Number(a.target)); break;
    case "match": controller.matchWeakest(); break;
    case "role": if (a.key && a.role) controller.setRole(a.key, a.role); break;
    case "apply": void controller.apply(); break;
    case "undo": void controller.undo(); break;
  }
});

void loadPage();
