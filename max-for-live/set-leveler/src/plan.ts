// Turns roles and measurements into the change each clip would get. Changes nothing itself.
import { dbToRaw, rawToDb } from "./gain-map.js";
import type { Role } from "./roles.js";
import type { ClipKey, Measure, SessionClip } from "./types.js";

export const DEFAULT_TARGET = -12;
export const DEFAULT_PEAK_LIMIT = 2;

export interface PlanRow {
  key: ClipKey;
  name: string;
  role: Role;
  changeDb: number | null;
  newRaw: number | null;
  clamped: boolean;
  unread: boolean;
}

export interface Plan {
  rows: PlanRow[];
  tracks: number;
  layers: number;
  needAnswer: ClipKey[];
  biggestDown: number;
  biggestUp: number;
  weakest: { key: ClipKey; name: string; costDb: number; matchTarget: number } | null;
}

export function makePlan(
  clips: SessionClip[],
  roles: Map<ClipKey, Role>,
  measures: Map<ClipKey, Measure>,
  target: number,
  peakLimit: number = DEFAULT_PEAK_LIMIT,
): Plan {
  const trackChange = new Map<ClipKey, number>();
  let weakest: Plan["weakest"] = null;

  for (const clip of clips) {
    const measure = measures.get(clip.key);
    if (roles.get(clip.key)?.kind !== "track" || clip.rawGain <= 0 || measure?.loudestLufs == null) continue;
    const gainDb = rawToDb(clip.rawGain);
    const change = target - (measure.loudestLufs + gainDb);
    trackChange.set(clip.key, change);
    if (measure.peakDb === null) continue;
    const over = measure.peakDb + gainDb + change - peakLimit;
    if (over > 1e-9 && (weakest === null || over > weakest.costDb)) {
      weakest = { key: clip.key, name: clip.name, costDb: over, matchTarget: target - over };
    }
  }

  const rows = clips.map((clip): PlanRow => {
    const role = roles.get(clip.key) ?? { kind: "leave" };
    let changeDb: number | null = null;
    if (clip.rawGain > 0) {
      if (role.kind === "track") changeDb = trackChange.get(clip.key) ?? null;
      if (role.kind === "layer" && role.host !== null) changeDb = trackChange.get(role.host) ?? null;
    }
    const next = changeDb === null ? null : dbToRaw(rawToDb(clip.rawGain) + changeDb);
    return {
      key: clip.key,
      name: clip.name,
      role,
      changeDb,
      newRaw: next && next.raw,
      clamped: next?.clamped ?? false,
      unread: role.kind === "track" && changeDb === null,
    };
  });

  const changes = rows.flatMap((r) => (r.changeDb === null ? [] : [r.changeDb]));
  return {
    rows,
    tracks: rows.filter((r) => r.role.kind === "track" && r.changeDb !== null).length,
    layers: rows.filter((r) => r.role.kind === "layer" && r.changeDb !== null).length,
    needAnswer: rows.filter((r) => r.role.kind === "layer" && r.role.host === null).map((r) => r.key),
    biggestDown: Math.min(0, ...changes),
    biggestUp: Math.max(0, ...changes),
    weakest,
  };
}
