import { BACKING, type Manifest, type Resolution } from "./manifest.js";
import type { SongSnapshot } from "./snapshot.js";

export type PassKind = "stem" | "master" | "extra";

export interface Pass {
  kind: PassKind;
  name: string;
  include: readonly string[];
  exclude: readonly string[];
  outputName: string;
}

export function buildPlan(s: SongSnapshot, m: Manifest, r: Resolution): Pass[] {
  // Assumes a validated manifest — a stem with computed: true under a name other than
  // Backing would otherwise yield a silent pass, which empty-stem catches.
  const audible = s.tracks.filter((t) => t.audible).map((t) => t.key);
  const complement = (include: readonly string[]) => {
    const set = new Set(include);
    return audible.filter((k) => !set.has(k));
  };

  const stemNames = Object.keys(m.stems).filter((n) => n !== BACKING);
  // Backing is the computed remainder: skip it entirely when nothing is unclaimed,
  // rather than rendering a silent pass.
  if (BACKING in m.stems && r.backing.length > 0) stemNames.push(BACKING);

  const passes: Pass[] = stemNames.map((name) => {
    const include =
      name === BACKING
        ? [...r.backing]
        : audible.filter((k) => r.assigned.get(k) === name);
    return {
      kind: "stem" as const,
      name,
      include,
      exclude: complement(include),
      outputName: `${m.song} (${name})${m.stems[name].suffix ?? ""}.wav`,
    };
  });

  passes.push({
    kind: "master",
    name: "— Master reference —",
    include: [...audible],
    exclude: [],
    outputName: `${m.song} (MASTER REFERENCE).wav`,
  });

  for (const extra of m.extras) {
    const keys = new Set(extra.trackKeys);
    const include = audible.filter((k) => keys.has(k));
    // Skip extras that resolve to no audible tracks, just like empty Backing.
    if (include.length === 0) continue;
    passes.push({
      kind: "extra",
      name: extra.name,
      include,
      exclude: complement(include),
      outputName: `${m.song} (${extra.name}).wav`,
    });
  }

  return passes;
}
