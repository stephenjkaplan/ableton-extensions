import { instrumentOf, isKnown, suggest, type Registry } from "./registry.js";
import { BACKING, type Manifest, type Resolution } from "./manifest.js";
import { PRE_MIXER_TAPS, type SongSnapshot, type TapPoint } from "./snapshot.js";

export type Severity = "error" | "warn" | "info" | "ok";
export interface Finding { severity: Severity; rule: string; title: string; detail: string }
export interface KeyTap {
  trackKey: string;
  keyTrackKey: string;
  keyTrackName: string;
  tap: TapPoint;
}

/** The stem an audible track renders in; unassigned audible tracks fall into Backing. */
function stemOf(s: SongSnapshot, r: Resolution, key: string): string | undefined {
  const assigned = r.assigned.get(key);
  if (assigned) return assigned;
  return s.byKey.get(key)?.audible ? BACKING : undefined;
}

/** Every stem pass in which this track (or, for a group, any of its children) is heard. */
function stemsHearing(s: SongSnapshot, r: Resolution, key: string): Set<string> {
  const out = new Set<string>();
  const members = s.byKey.get(key)?.isGroup ? s.descendantsOf(key) : [s.byKey.get(key)];
  for (const t of members) {
    const stem = t && stemOf(s, r, t.key);
    if (stem) out.add(stem);
  }
  return out;
}

const names = (s: SongSnapshot, keys: Iterable<string>): string[] =>
  [...keys].map((k) => s.byKey.get(k)?.name ?? k);

function masterFindings(s: SongSnapshot): Finding[] {
  const live = s.masterDevices.filter((d) => d.enabled).map((d) => d.name);
  if (live.length === 0)
    return [{ severity: "ok", rule: "master-clean", title: "Main track is clean",
              detail: "No enabled devices on the main track." }];
  return [{ severity: "error", rule: "master-live", title: "Main track has enabled devices",
            detail: `Disable or remove before exporting: ${live.join(", ")}.` }];
}

function unresolvedFindings(r: Resolution): Finding[] {
  return r.unresolved.map((k) => ({
    severity: "error", rule: "unresolved-ref", title: "Manifest references a missing track",
    detail: `'${k}' is not a track in this set (or is a group or computed Backing entry).`,
  }));
}

function doubleClaimedFindings(r: Resolution): Finding[] {
  return r.doubleClaimed.map((k) => ({
    severity: "error", rule: "double-claimed", title: "Track claimed by more than one stem",
    detail: `'${k}' is listed in more than one stem; stems must be a strict partition.`,
  }));
}

function unknownStemFindings(m: Manifest, reg: Registry): Finding[] {
  const out: Finding[] = [];
  for (const name of Object.keys(m.stems)) {
    if (isKnown(reg, name)) continue;
    const hint = suggest(reg, name);
    out.push({
      severity: "error", rule: "unknown-stem", title: "Unknown stem name",
      detail: `'${name}' is not in the stem registry.${hint ? ` Did you mean '${hint}'?` : ""}`,
    });
  }
  return out;
}

function emptyStemFindings(m: Manifest, r: Resolution): Finding[] {
  const out: Finding[] = [];
  for (const stem of Object.keys(m.stems)) {
    // Backing is the computed remainder, not a user claim; an empty remainder means
    // everything was explicitly assigned, which is the ideal outcome.
    if (stem === BACKING) continue;
    const count = [...r.assigned.values()].filter((v) => v === stem).length;
    if (count === 0)
      out.push({
        severity: "error", rule: "empty-stem", title: "Stem would render silent",
        detail: `'${stem}' has no audible tracks.`,
      });
  }
  return out;
}

function postMixerKeyFindings(
  s: SongSnapshot, r: Resolution, taps: readonly KeyTap[],
): Finding[] {
  const out: Finding[] = [];
  for (const t of taps) {
    if (PRE_MIXER_TAPS.has(t.tap)) continue;
    // When the key is a group, a pass holding only SOME of its children still counts as
    // including it; a partial-key ducking difference is deliberately not flagged.
    const keyStems = stemsHearing(s, r, t.keyTrackKey);
    // A muted key is silent in the Master reference too, so no pass loses anything.
    if (keyStems.size === 0) continue;
    const cut = [...stemsHearing(s, r, t.trackKey)].filter((x) => !keyStems.has(x));
    if (cut.length === 0) continue;
    const tapped = s.byKey.get(t.trackKey)?.name ?? t.trackKey;
    out.push({
      severity: "error", rule: "post-mixer-key", title: "Sidechain key is cut from a pass",
      detail: `'${tapped}' is keyed from '${t.keyTrackName}' at ${t.tap}, but the `
        + `${cut.map((x) => `'${x}'`).join(", ")} pass(es) exclude '${t.keyTrackName}', `
        + `so the ducking would be lost.`,
    });
  }
  return out;
}

function splitGroupFindings(s: SongSnapshot, r: Resolution): Finding[] {
  const out: Finding[] = [];
  for (const g of s.tracks) {
    if (!g.isGroup || g.devices.length === 0) continue;
    const stems = new Set<string>();
    for (const d of s.descendantsOf(g.key)) {
      const stem = stemOf(s, r, d.key);
      if (stem) stems.add(stem);
    }
    if (stems.size > 1)
      out.push({
        severity: "warn", rule: "split-group", title: "Processed group is split across stems",
        detail: `Group '${g.name}' has devices (${g.devices.join(", ")}) but its tracks land in `
          + `${[...stems].join(", ")}; its processing will not be applied consistently.`,
      });
  }
  return out;
}

function slotOverflowFindings(m: Manifest, reg: Registry): Finding[] {
  const used = new Set<string>();
  for (const stem of Object.keys(m.stems)) {
    const inst = instrumentOf(reg, stem);
    if (inst) used.add(inst);
  }
  if (used.size <= reg.instrumentSlotsPerDeck) return [];
  return [{
    severity: "warn", rule: "slot-overflow", title: "More instruments than deck slots",
    detail: `${used.size} instruments (${[...used].join(", ")}) exceed the `
      + `${reg.instrumentSlotsPerDeck} slots per deck.`,
  }];
}

function backingFallthroughFindings(s: SongSnapshot, r: Resolution): Finding[] {
  if (r.backing.length === 0) return [];
  return [{
    severity: "info", rule: "backing-fallthrough", title: "Tracks falling through to Backing",
    detail: names(s, r.backing).join(", "),
  }];
}

function mutedHeldOutFindings(s: SongSnapshot): Finding[] {
  const muted = s.tracks.filter((t) => !t.isGroup && t.muted).map((t) => t.key);
  if (muted.length === 0) return [];
  return [{
    severity: "info", rule: "muted-held-out", title: "Muted tracks held out of every stem",
    detail: muted.join(", "),
  }];
}

export function validate(
  s: SongSnapshot, m: Manifest, r: Resolution, reg: Registry,
  taps: readonly KeyTap[],
): Finding[] {
  return [
    ...masterFindings(s),
    ...unresolvedFindings(r),
    ...doubleClaimedFindings(r),
    ...unknownStemFindings(m, reg),
    ...emptyStemFindings(m, r),
    ...postMixerKeyFindings(s, r, taps),
    ...splitGroupFindings(s, r),
    ...slotOverflowFindings(m, reg),
    ...backingFallthroughFindings(s, r),
    ...mutedHeldOutFindings(s),
  ];
}

export function blocking(f: readonly Finding[]): Finding[] {
  return f.filter((x) => x.severity === "error");
}
