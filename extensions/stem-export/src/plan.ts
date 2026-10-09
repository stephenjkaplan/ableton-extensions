import type { Manifest, Resolution } from "./manifest.js";
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
  const audible = s.tracks.filter((t) => t.audible).map((t) => t.key);
  const complement = (include: readonly string[]) => {
    const set = new Set(include);
    return audible.filter((k) => !set.has(k));
  };

  const stemNames = Object.keys(m.stems).filter((n) => n !== "Backing");
  // Backing is the computed remainder: skip it entirely when nothing is unclaimed,
  // rather than rendering a silent pass.
  if ("Backing" in m.stems && r.backing.length > 0) stemNames.push("Backing");

  const passes: Pass[] = stemNames.map((name) => {
    const include =
      name === "Backing"
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
    include: audible,
    exclude: [],
    outputName: `${m.song} (MASTER REFERENCE).wav`,
  });

  for (const extra of m.extras) {
    const keys = new Set(extra.trackKeys);
    const include = audible.filter((k) => keys.has(k));
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
