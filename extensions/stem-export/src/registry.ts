export interface Instrument { name: string; variants: string[] }
export interface Registry {
  instruments: Instrument[];
  fixedStems: string[];
  instrumentSlotsPerDeck: number;
}

export function stemNames(r: Registry): ReadonlySet<string> {
  const out = new Set(r.fixedStems);
  for (const i of r.instruments) for (const v of i.variants) out.add(`${i.name} - ${v}`);
  return out;
}

export function isKnown(r: Registry, name: string): boolean {
  return stemNames(r).has(name);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

export function suggest(r: Registry, name: string): string | null {
  let best: string | null = null;
  let bestD = 3; // accept edit distance <= 2
  for (const candidate of stemNames(r)) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestD) { bestD = d; best = candidate; }
  }
  return best;
}

export function instrumentOf(r: Registry, stem: string): string | null {
  for (const i of r.instruments)
    if (i.variants.some((v) => stem === `${i.name} - ${v}`)) return i.name;
  return null;
}
