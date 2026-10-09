# Stem Export Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Ableton Live Extension that records a track→stem mapping for the open Set, validates it, drives the mute state for each render pass, and then names, levels and verifies the rendered stems into a finished folder the author drags into their library.

**Architecture:** A single resident extension. `activate()` registers commands; module state survives between them. Pure modules (`registry`, `manifest`, `validate`, `plan`, `audio`) have no SDK or I/O dependency and are unit-tested with `vitest` against plain fixtures. `snapshot` converts the live object model to plain data at one boundary. `run` owns all mutation and the watch loop.

**Tech Stack:** TypeScript, Node `>=24.16.0`, `@ableton-extensions/sdk` 1.0.0-beta.1 (vendored), esbuild, vitest. Target: Ableton Live 12 **Beta** 12.4.5+ Suite.

**Spec:** `docs/superpowers/specs/2026-10-09-stem-export-design.md` — read §12 and §13 first; they supersede earlier sections on platform and filesystem.

## Global Constraints

- **Filesystem: `storageDirectory` and `tempDirectory` only.** Never read or write
  `~/Documents`, `~/Downloads`, `~/Desktop`, or any path outside those two. No
  `child_process` workaround — the docs forbid it explicitly. (spec §13)
- **The extension never touches a `.als` file.** It reads the live object model.
- **Final output stops at `storageDirectory/out/<song>/`.** The author moves it. (spec §13)
- Stems are a **strict partition** — every audible track in exactly one stem. (spec §2)
- `Backing` is **computed**, never enumerated. (spec §4)
- Extras overlap freely and sit outside the null sum. (spec §2, §8)
- Audible = not a group track, not a return track, not muted by the author.
- Output names: `<song> (<stem>)<suffix>.wav`, extras under `Extras/`. (spec §4)
- One gain per song across every stem and extra; true-peak ceiling `-6.0 dBFS`; default
  target `-18.0 LUFS`. (spec §7)
- Null residual threshold `-60.0 dBFS`. (spec §8)
- All Live mutations go through `context.withinTransaction()`.
- **Author state is sacred:** snapshot every mute and Master device-enable value before the
  run and restore it exactly, including on abort and on error.

## Review Focus

Five failure modes the spec implies that no happy-path test covers. Each gets its test in the
task that owns the code.

1. **Duplicate track names.** `Learning to Feel` has two tracks named `Acid V MIDI` and two
   named `Chem Bros 3`, and `Handle.id` is session-scoped so it cannot be the manifest key.
   Identity must be `groupPath/name#ordinal` and must stay stable across a reload. → Task 2.
2. **Author's own mutes are destroyed.** If the run crashes or Live quits mid-run, the set is
   left with 60 tracks muted and the Master bypassed. State must be persisted to
   `storageDirectory` at snapshot time so a later command can still restore it. → Task 7.
3. **A render arrives that is not a stem.** The author exports something unrelated into the
   temp directory, or Live writes a `.asd` alongside. The watcher must ignore non-matching
   files rather than consuming a pass. → Task 7.
4. **Mismatched renders when summing.** Different lengths, rates, or channel counts. Must
   throw, not zero-pad — a silently padded sum makes the null test pass for the wrong
   reason. → Task 6.
5. **Unsafe characters in song or stem names.** A `/` must not escape the output directory,
   and an empty name must not produce a dotfile. → Task 7.

---

### Task 1: Scaffold and the resident-lifecycle spike

**Files:**
- Create: `extensions/stem-export/` (via Ableton's scaffolder)
- Create: `extensions/stem-export/src/extension.ts`
- Create: `extensions/stem-export/vitest.config.ts`
- Test: `extensions/stem-export/test/smoke.test.ts`
- Create: `docs/superpowers/notes/lifecycle-spike.md`

**Interfaces:**
- Consumes: the vendored tarballs already at `extensions/stem-export/vendor/`.
- Produces: a building, loadable extension; `npm run build`, `npm test`, `npm start` work.
  Also the **answer to the spike**, which Task 7 depends on.

- [ ] **Step 1: Scaffold with Ableton's own creator**

Use the official scaffolder so the project matches Ableton's conventions rather than ours.

```bash
cd extensions
npm create @ableton-extensions/extension@file:../extensions/stem-export/vendor/ableton-create-extension-1.0.0-beta.1.tgz
```

If the creator cannot be invoked from a local tarball, extract its templates instead and
copy them, preserving every file it ships: `package.json`, `manifest.json`, `build.ts`,
`tsconfig.json`, `vite.config.ts`, `.vscode/`, `src/html.d.ts`, `ui/interface.html`,
`gitignore`, `.env`.

Name the extension `stem-export`, author `Stephen Kaplan`. Point the SDK and CLI deps at the
vendored tarballs:

```json
"dependencies":  { "@ableton-extensions/sdk": "file:./vendor/ableton-extensions-sdk-1.0.0-beta.1.tgz" },
"devDependencies": { "@ableton-extensions/cli": "file:./vendor/ableton-extensions-cli-1.0.0-beta.1.tgz" }
```

Set `.env` to the installed beta:

```
EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node
```

- [ ] **Step 2: Add vitest**

```bash
cd extensions/stem-export && npm i -D vitest
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 3: Write a smoke test**

Create `test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("scaffold", () => {
  it("manifest declares the entry point and api version", () => {
    const m = JSON.parse(readFileSync("manifest.json", "utf8"));
    expect(m.entry).toMatch(/dist\/extension\.js$/);
    expect(m.minimumApiVersion).toBe("1.0.0");
    expect(m.name).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd extensions/stem-export && npm test`
Expected: 1 passed.

- [ ] **Step 5: Write the spike extension**

Replace `src/extension.ts`. This answers the two questions Task 7 depends on: does the
extension stay resident between commands, and does a `fs.watch` started in a command keep
firing while Live is usable?

```ts
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { watch } from "node:fs";
import { mkdirSync } from "node:fs";

let commandCount = 0;
let watcherEvents = 0;

export const activate = (activation: ActivationContext) => {
  const context = initialize(activation, "1.0.0");
  const started = Date.now();
  console.log(`[spike] activate() at ${new Date(started).toISOString()}`);

  context.commands.registerCommand("stem-export.spike", async () => {
    commandCount += 1;
    const temp = context.environment.tempDirectory;
    console.log(
      `[spike] command #${commandCount}; ` +
        `${Math.round((Date.now() - started) / 1000)}s since activate; ` +
        `watcherEvents=${watcherEvents}; temp=${temp}`,
    );

    if (commandCount === 1 && temp) {
      mkdirSync(temp, { recursive: true });
      watch(temp, (event, filename) => {
        watcherEvents += 1;
        console.log(`[spike] watcher fired #${watcherEvents}: ${event} ${filename}`);
      });
      console.log(`[spike] watching ${temp} — now export audio there`);
    }
  });

  context.ui.registerContextMenuAction("AudioTrack", "Stem Export: spike", "stem-export.spike");
  context.ui.registerContextMenuAction("MidiTrack", "Stem Export: spike", "stem-export.spike");
};
```

- [ ] **Step 6: Build and load it in Live**

```bash
cd extensions/stem-export && npm run build && npm start
```

In Live Beta: Settings → Extensions → enable **Developer Mode**, then right-click a track and
choose **Stem Export: spike**.

- [ ] **Step 7: Record the spike result**

Run the command three times, a minute apart. Then set Live's Export Audio destination to the
printed temp directory and export once.

Create `docs/superpowers/notes/lifecycle-spike.md` recording, with the actual console output:

1. Does `commandCount` increment across invocations — i.e. is module state retained?
2. Does the "seconds since activate" value keep growing — i.e. is the process resident?
3. Does the watcher fire when Live writes a render, and does Live stay usable meanwhile?

**If all three are yes**, Task 7 implements the automatic watch loop. **If any is no**, Task 7
implements the manual `Next Pass` loop instead; every other task is unaffected.

- [ ] **Step 8: Commit**

```bash
git add extensions/stem-export docs/superpowers/notes
git commit -m "feat: scaffold stem-export extension and record lifecycle spike"
```

---

### Task 2: Track snapshot and stable identity

**Files:**
- Create: `extensions/stem-export/src/snapshot.ts`
- Test: `extensions/stem-export/test/snapshot.test.ts`

**Interfaces:**
- Consumes: the SDK's `Song`, `Track` (see `docs/sdk/sdk-api.d.ts`).
- Produces:

```ts
export type TapPoint = "Pre FX" | "Post FX" | "Post Mixer";
export const PRE_MIXER_TAPS: ReadonlySet<TapPoint>;        // {"Pre FX","Post FX"}

export interface TrackSnapshot {
  key: string;          // stable: "Group/Path/Name#ordinal"
  name: string;
  groupPath: readonly string[];
  isGroup: boolean;
  muted: boolean;
  devices: readonly string[];
  audible: boolean;     // !isGroup && !muted
}
export interface SongSnapshot {
  song: string;
  tracks: readonly TrackSnapshot[];
  masterDevices: readonly { name: string; enabled: boolean }[];
  byKey: ReadonlyMap<string, TrackSnapshot>;
  descendantsOf(key: string): readonly TrackSnapshot[];
}
export function snapshotSong(song: SongLike, songName: string): SongSnapshot;
```

`SongLike` is a structural interface over the SDK's `Song` so tests can pass fakes:

```ts
export interface TrackLike {
  name: string; mute: boolean;
  groupTrack: TrackLike | null;
  devices: readonly { name: string }[];
}
export interface SongLike { tracks: readonly TrackLike[]; mainTrack: TrackLike }
```

**Identity.** `Handle.id` is documented as "an arbitrary number assigned by the host", so it
is session-scoped and unusable as a key. The key is the group path joined by `/`, then the
name, then `#n` where `n` is the 1-based ordinal among same-named siblings **in track order**.
A track with a unique name among its siblings gets no `#n` suffix.

**Group detection.** There is no `GroupTrack` class. A track is a group iff it appears as
some other track's `groupTrack`.

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRE_MIXER_TAPS, snapshotSong, type TrackLike } from "../src/snapshot.js";

function mk(name: string, group: TrackLike | null = null, opts: Partial<TrackLike> = {}): TrackLike {
  return { name, mute: false, groupTrack: group, devices: [], ...opts };
}

describe("snapshotSong", () => {
  it("derives group tracks from groupTrack back-references", () => {
    const drums = mk("Drums");
    const kick = mk("Kick", drums);
    const s = snapshotSong({ tracks: [drums, kick], mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Drums")!.isGroup).toBe(true);
    expect(s.byKey.get("Drums/Kick")!.isGroup).toBe(false);
  });

  it("builds the group path", () => {
    const drums = mk("Drums");
    const sc = mk("Sidechained", drums);
    const cam = mk("Cam Drums", sc);
    const s = snapshotSong({ tracks: [drums, sc, cam], mainTrack: mk("Main") }, "Song");
    expect(s.byKey.get("Drums/Sidechained/Cam Drums")!.groupPath).toEqual(["Drums", "Sidechained"]);
  });

  it("disambiguates duplicate names with an ordinal", () => {
    // Review Focus 1: Learning to Feel really has two tracks named "Acid V MIDI".
    const arps = mk("Arps");
    const a1 = mk("Acid V MIDI", arps);
    const a2 = mk("Acid V MIDI", arps);
    const s = snapshotSong({ tracks: [arps, a1, a2], mainTrack: mk("Main") }, "Song");
    expect([...s.byKey.keys()]).toContain("Arps/Acid V MIDI#1");
    expect([...s.byKey.keys()]).toContain("Arps/Acid V MIDI#2");
  });

  it("does not add an ordinal to unique names", () => {
    const s = snapshotSong({ tracks: [mk("Bass")], mainTrack: mk("Main") }, "Song");
    expect([...s.byKey.keys()]).toEqual(["Bass"]);
  });

  it("keys are stable across a re-snapshot of the same set", () => {
    // Review Focus 1: identity must survive a reload, which handles cannot.
    const build = () => {
      const arps = mk("Arps");
      return { tracks: [arps, mk("Acid V MIDI", arps), mk("Acid V MIDI", arps)], mainTrack: mk("Main") };
    };
    const a = snapshotSong(build(), "Song");
    const b = snapshotSong(build(), "Song");
    expect([...a.byKey.keys()]).toEqual([...b.byKey.keys()]);
  });

  it("audible excludes groups and author-muted tracks", () => {
    const drums = mk("Drums");
    const s = snapshotSong(
      { tracks: [drums, mk("Kick", drums), mk("Snare", drums, { mute: true }), mk("Bass")],
        mainTrack: mk("Main") }, "Song");
    expect(s.tracks.filter(t => t.audible).map(t => t.name)).toEqual(["Kick", "Bass"]);
  });

  it("captures device names and master device state", () => {
    const main = mk("Main", null, { devices: [{ name: "Limiter" }] });
    const grp = mk("Arps", null, { devices: [{ name: "GlueCompressor" }] });
    const s = snapshotSong({ tracks: [grp, mk("Acid", grp)], mainTrack: main }, "Song");
    expect(s.byKey.get("Arps")!.devices).toEqual(["GlueCompressor"]);
    expect(s.masterDevices).toEqual([{ name: "Limiter", enabled: true }]);
  });

  it("descendantsOf returns the whole subtree", () => {
    const drums = mk("Drums");
    const sc = mk("Sidechained", drums);
    const s = snapshotSong(
      { tracks: [drums, sc, mk("Cam Drums", sc), mk("Bass")], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums").map(t => t.name)).toEqual(["Sidechained", "Cam Drums"]);
  });

  it("does not treat a name-prefixed sibling group as a child", () => {
    // "Drums A" / "Drums B" is the live set's own naming style; a joined-string
    // prefix match would make B's children look like A's.
    const a = mk("Drums A");
    const b = mk("Drums B");
    const s = snapshotSong(
      { tracks: [a, mk("Kick", a), b, mk("Shaker", b)], mainTrack: mk("Main") }, "Song");
    expect(s.descendantsOf("Drums A").map((t) => t.name)).toEqual(["Kick"]);
  });

  it("exports the pre-mixer tap set", () => {
    expect([...PRE_MIXER_TAPS].sort()).toEqual(["Post FX", "Pre FX"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/stem-export && npx vitest run test/snapshot.test.ts`
Expected: FAIL — cannot resolve `../src/snapshot.js`.

- [ ] **Step 3: Implement the snapshot**

Create `src/snapshot.ts`:

```ts
export type TapPoint = "Pre FX" | "Post FX" | "Post Mixer";
export const PRE_MIXER_TAPS: ReadonlySet<TapPoint> = new Set<TapPoint>(["Pre FX", "Post FX"]);

export interface TrackLike {
  name: string;
  mute: boolean;
  groupTrack: TrackLike | null;
  devices: readonly { name: string }[];
}
export interface SongLike {
  tracks: readonly TrackLike[];
  mainTrack: TrackLike;
}

export interface TrackSnapshot {
  key: string;
  name: string;
  groupPath: readonly string[];
  isGroup: boolean;
  muted: boolean;
  devices: readonly string[];
  audible: boolean;
}

export interface SongSnapshot {
  song: string;
  tracks: readonly TrackSnapshot[];
  masterDevices: readonly { name: string; enabled: boolean }[];
  byKey: ReadonlyMap<string, TrackSnapshot>;
  descendantsOf(key: string): readonly TrackSnapshot[];
}

function pathOf(track: TrackLike): string[] {
  const out: string[] = [];
  for (let g = track.groupTrack; g; g = g.groupTrack) out.unshift(g.name);
  return out;
}

export function snapshotSong(song: SongLike, songName: string): SongSnapshot {
  const groups = new Set<TrackLike>();
  for (const t of song.tracks) if (t.groupTrack) groups.add(t.groupTrack);

  // Count same-name siblings so only genuine duplicates get an ordinal.
  const siblingCounts = new Map<string, number>();
  const prefixOf = (t: TrackLike) => [...pathOf(t), t.name].join("/");
  for (const t of song.tracks) {
    const p = prefixOf(t);
    siblingCounts.set(p, (siblingCounts.get(p) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const tracks: TrackSnapshot[] = song.tracks.map((t) => {
    const prefix = prefixOf(t);
    const isGroup = groups.has(t);
    let key = prefix;
    if ((siblingCounts.get(prefix) ?? 0) > 1) {
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      key = `${prefix}#${n}`;
    }
    return {
      key,
      name: t.name,
      groupPath: pathOf(t),
      isGroup,
      muted: t.mute,
      devices: t.devices.map((d) => d.name),
      audible: !isGroup && !t.mute,
    };
  });

  const byKey = new Map(tracks.map((t) => [t.key, t]));

  return {
    song: songName,
    tracks,
    byKey,
    masterDevices: song.mainTrack.devices.map((d) => ({ name: d.name, enabled: true })),
    descendantsOf(key) {
      const root = byKey.get(key);
      if (!root) return [];
      // Compare path SEGMENTS, not a joined string: a prefix match would make
      // "Drums A" a parent of "Drums B".
      const prefix = [...root.groupPath, root.name];
      const isUnder = (path: readonly string[]) =>
        path.length >= prefix.length && prefix.every((seg, i) => path[i] === seg);
      return tracks.filter((t) => t !== root && isUnder(t.groupPath));
    },
  };
}
```

> **Note for the implementer:** `masterDevices[].enabled` is hard-coded `true` here because
> `TrackLike` has no parameter access. Task 7 reads the real enabled state via
> `device.parameters.find(p => p.name === "Device On")` and `getValue()`, and passes it in.
> Widen `TrackLike.devices` to carry `enabled` when you get there, and update this test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/snapshot.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add extensions/stem-export/src/snapshot.ts extensions/stem-export/test/snapshot.test.ts
git commit -m "feat: song snapshot with group-path track identity"
```

---

### Task 3: Registry and manifest

**Files:**
- Create: `extensions/stem-export/src/registry.ts`
- Create: `extensions/stem-export/src/manifest.ts`
- Create: `extensions/stem-export/src/default-registry.ts`
- Test: `extensions/stem-export/test/registry.test.ts`
- Test: `extensions/stem-export/test/manifest.test.ts`

**Interfaces:**

```ts
// registry.ts
export interface Instrument { name: string; variants: string[] }
export interface Registry {
  instruments: Instrument[]; fixedStems: string[];
  instrumentSlotsPerDeck: number; extrasDir: string;
}
export function stemNames(r: Registry): ReadonlySet<string>;
export function isKnown(r: Registry, name: string): boolean;
export function suggest(r: Registry, name: string): string | null;   // Levenshtein <= 2
export function instrumentOf(r: Registry, stem: string): string | null;
export const DEFAULT_REGISTRY: Registry;                              // default-registry.ts

// manifest.ts
export interface Manifest {
  song: string;
  targetLufs: number; truePeakCeilingDb: number; appliedGainDb: number | null;
  stems: Record<string, { trackKeys: string[]; suffix?: string; computed?: boolean }>;
  extras: { name: string; trackKeys: string[] }[];
}
export interface Resolution {
  assigned: ReadonlyMap<string, string>;   // trackKey -> stem
  backing: readonly string[];              // trackKeys
  unresolved: readonly string[];           // manifest keys with no matching track
  doubleClaimed: readonly string[];
}
export function resolve(m: Manifest, s: SongSnapshot): Resolution;
export function emptyManifest(song: string): Manifest;
export function safeName(name: string): string;      // filesystem-safe path component
export function manifestPath(storageDir: string, song: string): string;
export function loadManifest(path: string): Manifest | null;   // null if absent
export function saveManifest(m: Manifest, path: string): void;
```

Manifests are **JSON**, not YAML — no dependency, and nothing hand-edits them now that the
mapping UI exists. `manifestPath` is `<storageDir>/manifests/<safeSongName>.json`.

- [ ] **Step 1: Write the registry seed**

Create `src/default-registry.ts`, seeded from `Live Set (Columbus - Arturia)` and the
stem-frequency data in spec §2 (`Rhodes` and `Clavinet` are more common than `Keys`):

```ts
import type { Registry } from "./registry.js";

export const DEFAULT_REGISTRY: Registry = {
  instruments: [
    { name: "Guitar",   variants: ["Played", "Backing"] },
    { name: "Sub37",    variants: ["Played ONLY SUB", "Played Rev2-able", "Backing"] },
    { name: "Rev2",     variants: ["Played", "Backing"] },
    { name: "Organ",    variants: ["Played", "Backing"] },
    { name: "Rhodes",   variants: ["Played", "Backing"] },
    { name: "Clavinet", variants: ["Played", "Backing"] },
    { name: "Pianet",   variants: ["Played", "Backing"] },
    { name: "Piano",    variants: ["Played", "Backing"] },
    { name: "Keys",     variants: ["Played", "Backing"] },
    { name: "Arturia",  variants: ["Played", "Backing"] },
    { name: "Serum",    variants: ["Played", "Backing"] },
    { name: "Vibes",    variants: ["Played", "Backing"] },
    { name: "Talkbox",  variants: ["Played", "Backing"] },
    { name: "Vocals",   variants: ["Played", "Backing"] },
    { name: "Samples",  variants: ["Played", "Backing"] },
  ],
  fixedStems: ["Drums", "Vocals", "Samples", "Vocal Samples", "Backing"],
  instrumentSlotsPerDeck: 8,
  extrasDir: "Extras",
};
```

- [ ] **Step 2: Write the failing registry tests**

Create `test/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY as R } from "../src/default-registry.js";
import { instrumentOf, isKnown, stemNames, suggest } from "../src/registry.js";

describe("registry", () => {
  it("expands instrument variants", () => {
    const n = stemNames(R);
    expect(n.has("Sub37 - Played Rev2-able")).toBe(true);
    expect(n.has("Clavinet - Played")).toBe(true);
    expect(n.has("Rhodes - Backing")).toBe(true);
  });

  it("includes fixed stems", () => {
    for (const s of ["Drums", "Backing", "Vocal Samples"]) expect(isKnown(R, s)).toBe(true);
  });

  it("rejects the real typos from the library", () => {
    expect(isKnown(R, "Organ - Playedl")).toBe(false);
    expect(isKnown(R, "Sub37- Played")).toBe(false);
  });

  it("suggests the nearest legal name", () => {
    expect(suggest(R, "Organ - Playedl")).toBe("Organ - Played");
    expect(suggest(R, "Sub37- Played")).toBe("Sub37 - Played");
  });

  it("returns null when nothing is close", () => {
    expect(suggest(R, "Didgeridoo Orchestra")).toBeNull();
  });

  it("maps a stem back to its instrument", () => {
    expect(instrumentOf(R, "Rhodes - Backing")).toBe("Rhodes");
    expect(instrumentOf(R, "Drums")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 4: Implement the registry**

Create `src/registry.ts`:

```ts
export interface Instrument { name: string; variants: string[] }
export interface Registry {
  instruments: Instrument[];
  fixedStems: string[];
  instrumentSlotsPerDeck: number;
  extrasDir: string;
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
```

- [ ] **Step 5: Write the failing manifest tests**

Create `test/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import { emptyManifest, loadManifest, manifestPath, resolve, safeName, saveManifest,
         type Manifest } from "../src/manifest.js";

const mk = (name: string, group: TrackLike | null = null, mute = false): TrackLike =>
  ({ name, mute, groupTrack: group, devices: [] });

function snap() {
  const drums = mk("Drums");
  return snapshotSong(
    { tracks: [drums, mk("Kick", drums), mk("Snare", drums, true), mk("Bass")],
      mainTrack: mk("Main") }, "Song");
}

function withStems(stems: Manifest["stems"]): Manifest {
  return { ...emptyManifest("Song"), stems };
}

describe("manifest", () => {
  it("round-trips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    const m = withStems({
      "Arturia - Played": { trackKeys: ["Womp"], suffix: " Jup Sync Lead" },
      Backing: { trackKeys: [], computed: true },
    });
    const p = manifestPath(dir, "Song");
    saveManifest(m, p);
    const back = loadManifest(p)!;
    expect(back.stems["Arturia - Played"].suffix).toBe(" Jup Sync Lead");
    expect(back.stems.Backing.computed).toBe(true);
    expect(back.targetLufs).toBe(-18);
  });

  it("returns null for an absent manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-"));
    expect(loadManifest(manifestPath(dir, "Nope"))).toBeNull();
  });

  it("computes Backing as the unclaimed remainder", () => {
    const r = resolve(withStems({ "Drums": { trackKeys: ["Drums/Kick"] } }), snap());
    expect([...r.assigned.entries()]).toEqual([["Drums/Kick", "Drums"]]);
    expect(r.backing).toEqual(["Bass"]);
  });

  it("never puts author-muted tracks in Backing", () => {
    const r = resolve(withStems({}), snap());
    expect(r.backing).not.toContain("Drums/Snare");
    expect(r.backing).toEqual(["Drums/Kick", "Bass"]);
  });

  it("reports a stale track reference instead of throwing", () => {
    // Review Focus 1: a track renamed or deleted since the mapping was saved.
    const r = resolve(withStems({ Drums: { trackKeys: ["Drums/Ghost"] } }), snap());
    expect(r.unresolved).toEqual(["Drums/Ghost"]);
    expect(r.assigned.size).toBe(0);
  });

  it("flags a track claimed by two stems", () => {
    const r = resolve(withStems({
      Drums: { trackKeys: ["Drums/Kick"] },
      "Serum - Backing": { trackKeys: ["Drums/Kick"] },
    }), snap());
    expect(r.doubleClaimed).toEqual(["Drums/Kick"]);
  });

  it("makes names safe as path components", () => {
    // Review Focus 5: a "/" must not escape the output directory.
    expect(safeName("AC/DC Tribute")).toBe("AC_DC Tribute");
    expect(safeName("../../etc")).toBe(".._.._etc");
    expect(safeName("")).toBe("untitled");
    expect(safeName("   ")).toBe("untitled");
    expect(safeName("Learning to Feel")).toBe("Learning to Feel");
  });

  it("builds a manifest path inside the storage directory", () => {
    const p = manifestPath("/tmp/store", "AC/DC Tribute");
    expect(p).toBe("/tmp/store/manifests/AC_DC Tribute.json");
  });

  it("ignores assignments pointing at group tracks", () => {
    const r = resolve(withStems({ Drums: { trackKeys: ["Drums"] } }), snap());
    expect(r.assigned.size).toBe(0);
    expect(r.unresolved).toEqual(["Drums"]);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/manifest.js`.

- [ ] **Step 7: Implement the manifest**

Create `src/manifest.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SongSnapshot } from "./snapshot.js";

export interface StemSpec { trackKeys: string[]; suffix?: string; computed?: boolean }
export interface ExtraSpec { name: string; trackKeys: string[] }

export interface Manifest {
  song: string;
  targetLufs: number;
  truePeakCeilingDb: number;
  appliedGainDb: number | null;
  stems: Record<string, StemSpec>;
  extras: ExtraSpec[];
}

export interface Resolution {
  assigned: ReadonlyMap<string, string>;
  backing: readonly string[];
  unresolved: readonly string[];
  doubleClaimed: readonly string[];
}

export function emptyManifest(song: string): Manifest {
  return {
    song,
    targetLufs: -18,
    truePeakCeilingDb: -6,
    appliedGainDb: null,
    stems: { Backing: { trackKeys: [], computed: true } },
    extras: [],
  };
}

export function safeName(name: string): string {
  return name.replace(/[/\\\0]/g, "_").trim() || "untitled";
}

export function manifestPath(storageDir: string, song: string): string {
  return join(storageDir, "manifests", `${safeName(song)}.json`);
}

export function saveManifest(m: Manifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf8");
}

export function loadManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function resolve(m: Manifest, s: SongSnapshot): Resolution {
  const assigned = new Map<string, string>();
  const unresolved: string[] = [];
  const doubleClaimed: string[] = [];

  for (const [stem, spec] of Object.entries(m.stems)) {
    if (spec.computed) continue;
    for (const key of spec.trackKeys) {
      const track = s.byKey.get(key);
      if (!track || !track.audible) {
        if (!track || track.isGroup) unresolved.push(key);
        continue;
      }
      if (assigned.has(key) && assigned.get(key) !== stem) doubleClaimed.push(key);
      else assigned.set(key, stem);
    }
  }

  const backing = s.tracks
    .filter((t) => t.audible && !assigned.has(t.key))
    .map((t) => t.key);

  return {
    assigned,
    backing,
    unresolved: [...new Set(unresolved)],
    doubleClaimed: [...new Set(doubleClaimed)],
  };
}
```

- [ ] **Step 8: Run both suites**

Run: `npx vitest run test/registry.test.ts test/manifest.test.ts`
Expected: 15 passed.

- [ ] **Step 9: Commit**

```bash
git add extensions/stem-export/src extensions/stem-export/test
git commit -m "feat: stem registry and manifest with computed Backing"
```

---

### Task 4: Validator

**Files:**
- Create: `extensions/stem-export/src/validate.ts`
- Test: `extensions/stem-export/test/validate.test.ts`

**Interfaces:**

```ts
export type Severity = "error" | "warn" | "info" | "ok";
export interface Finding { severity: Severity; rule: string; title: string; detail: string }
export function validate(
  s: SongSnapshot, m: Manifest, r: Resolution, reg: Registry,
  taps: readonly { trackKey: string; keyTrackKey: string; keyTrackName: string; tap: TapPoint }[],
): Finding[];
export function blocking(f: readonly Finding[]): Finding[];
```

Sidechain taps are passed in rather than read from the snapshot, because the SDK exposes no
tap-point accessor — Task 7 supplies an empty array until that is resolved (see Task 7 Step 1).

Rules, per spec §6: `empty-stem` (error) · `unknown-stem` (error) · `master-live` (error) ·
`double-claimed` (error) · `unresolved-ref` (error) · `post-mixer-key` (error) ·
`split-group` (warn) · `slot-overflow` (warn) · `backing-fallthrough` (info) ·
`muted-held-out` (info) · `master-clean` (ok).

- [ ] **Step 1: Write the failing tests**

Create `test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY as R } from "../src/default-registry.js";
import { emptyManifest, resolve, type Manifest } from "../src/manifest.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import { blocking, validate } from "../src/validate.js";

const mk = (name: string, g: TrackLike | null = null, mute = false,
            devices: { name: string }[] = []): TrackLike =>
  ({ name, mute, groupTrack: g, devices });

const withStems = (stems: Manifest["stems"]): Manifest => ({ ...emptyManifest("Song"), stems });
const rules = (f: ReturnType<typeof validate>, sev?: string) =>
  new Set(f.filter((x) => !sev || x.severity === sev).map((x) => x.rule));

function run(song: Parameters<typeof snapshotSong>[0], m: Manifest, taps = []) {
  const s = snapshotSong(song, "Song");
  return validate(s, m, resolve(m, s), R, taps);
}

describe("validate", () => {
  it("flags an enabled master device and blocks", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main", null, false, [{ name: "Limiter" }]) },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "error")).toContain("master-live");
    expect(blocking(f).length).toBeGreaterThan(0);
  });

  it("reports a clean master", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "ok")).toContain("master-clean");
  });

  it("flags a stem that would render silent", () => {
    const f = run({ tracks: [mk("Bass", null, true)], mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(rules(f, "error")).toContain("empty-stem");
  });

  it("flags an unknown stem name and suggests a fix", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main") },
                  withStems({ "Organ - Playedl": { trackKeys: ["Bass"] } }));
    const hit = f.find((x) => x.rule === "unknown-stem")!;
    expect(hit.detail).toContain("Organ - Played");
  });

  it("warns when a processed group is split across stems", () => {
    const arps = mk("Arps", null, false, [{ name: "GlueCompressor" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid"] },
                  "Sub37 - Backing": { trackKeys: ["Arps/Pluck"] } }));
    const hit = f.find((x) => x.rule === "split-group")!;
    expect(hit.severity).toBe("warn");
    expect(hit.detail).toContain("Arps");
    expect(hit.detail).toContain("GlueCompressor");
  });

  it("does not warn when a processed group lands wholly in one stem", () => {
    const arps = mk("Arps", null, false, [{ name: "GlueCompressor" }]);
    const f = run({ tracks: [arps, mk("Acid", arps), mk("Pluck", arps)], mainTrack: mk("Main") },
      withStems({ "Arturia - Backing": { trackKeys: ["Arps/Acid", "Arps/Pluck"] } }));
    expect(rules(f, "warn")).not.toContain("split-group");
  });

  it("flags a Post Mixer key source excluded from a pass", () => {
    const f = run({ tracks: [mk("Kick"), mk("Sub")], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] }, "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post Mixer" }] as never);
    const hit = f.find((x) => x.rule === "post-mixer-key")!;
    expect(hit.severity).toBe("error");
    expect(hit.detail).toContain("Kick");
  });

  it("does not flag pre-mixer taps", () => {
    const f = run({ tracks: [mk("Kick"), mk("Sub")], mainTrack: mk("Main") },
      withStems({ Drums: { trackKeys: ["Kick"] }, "Serum - Backing": { trackKeys: ["Sub"] } }),
      [{ trackKey: "Sub", keyTrackKey: "Kick", keyTrackName: "Kick", tap: "Post FX" }] as never);
    expect(rules(f, "error")).not.toContain("post-mixer-key");
  });

  it("reports Backing fall-through and held-out mutes", () => {
    const f = run({ tracks: [mk("Kick"), mk("Bass"), mk("Old Idea", null, true)],
                    mainTrack: mk("Main") },
                  withStems({ Drums: { trackKeys: ["Kick"] } }));
    expect(f.find((x) => x.rule === "backing-fallthrough")!.detail).toContain("Bass");
    expect(f.find((x) => x.rule === "muted-held-out")!.detail).toContain("Old Idea");
  });

  it("blocking returns only errors", () => {
    const f = run({ tracks: [mk("Bass")], mainTrack: mk("Main", null, false, [{ name: "X" }]) },
                  withStems({ Drums: { trackKeys: ["Bass"] } }));
    expect(blocking(f).every((x) => x.severity === "error")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/validate.test.ts`
Expected: FAIL — cannot resolve `../src/validate.js`.

- [ ] **Step 3: Implement the validator**

Create `src/validate.ts`, implementing exactly the rules listed in the Interfaces block
above. Structure it as one small function per rule, each returning `Finding[]`, and a
`validate` that concatenates them — that keeps each rule independently readable and lets a
reviewer check one rule against one test.

Required behaviour, rule by rule:

- `master-live` / `master-clean` — error listing enabled device names, or an ok finding.
- `unresolved-ref` — one error per `resolution.unresolved` key.
- `double-claimed` — one error per `resolution.doubleClaimed` key.
- `unknown-stem` — for each stem name in the manifest not in `stemNames(registry)`; append
  `` Did you mean '<suggest()>'? `` when `suggest` returns non-null.
- `empty-stem` — for each stem whose member set is empty. Members of `Backing` are
  `resolution.backing`; members of any other stem are the keys assigned to it.
- `post-mixer-key` — for each tap whose `tap` is not in `PRE_MIXER_TAPS`, if any pass excludes
  the key track while including the tapped track, emit one error naming both and the stem.
  Emit at most one finding per tap.
- `split-group` — for each group track with a non-empty `devices` list, collect the stems of
  its audible descendants (treating unassigned as `Backing`); if more than one distinct stem,
  warn naming the group, its devices, and the stems.
- `slot-overflow` — warn if the count of distinct non-null `instrumentOf()` values across stem
  names exceeds `registry.instrumentSlotsPerDeck`.
- `backing-fallthrough` — info listing the names of `resolution.backing` tracks.
- `muted-held-out` — info listing names of non-group tracks with `muted === true`.

```ts
export function blocking(f: readonly Finding[]): Finding[] {
  return f.filter((x) => x.severity === "error");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/validate.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add extensions/stem-export/src/validate.ts extensions/stem-export/test/validate.test.ts
git commit -m "feat: pre-flight validation rules"
```

---

### Task 5: Render planner

**Files:**
- Create: `extensions/stem-export/src/plan.ts`
- Test: `extensions/stem-export/test/plan.test.ts`

**Interfaces:**

```ts
export type PassKind = "stem" | "master" | "extra";
export interface Pass {
  kind: PassKind;
  name: string;
  include: readonly string[];   // trackKeys audible in this pass
  exclude: readonly string[];   // trackKeys to mute
  outputName: string;           // final filename, e.g. "Song (Drums).wav"
}
export function buildPlan(s: SongSnapshot, m: Manifest, r: Resolution): Pass[];
```

Order: stems in manifest order with `Backing` last, then the Master reference, then extras.
Master pass excludes nothing. `outputName` applies the stem's `suffix`.

- [ ] **Step 1: Write the failing tests**

Create `test/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyManifest, resolve, type Manifest } from "../src/manifest.js";
import { buildPlan } from "../src/plan.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";

const mk = (name: string, g: TrackLike | null = null, mute = false): TrackLike =>
  ({ name, mute, groupTrack: g, devices: [] });

const SONG = { tracks: [mk("Kick"), mk("Bass")], mainTrack: mk("Main") };
const m = (over: Partial<Manifest>): Manifest => ({ ...emptyManifest("Song"), ...over });

function plan(man: Manifest) {
  const s = snapshotSong(SONG, man.song);
  return buildPlan(s, man, resolve(man, s));
}

describe("buildPlan", () => {
  it("emits stems, then master, then extras", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } },
                       extras: [{ name: "Kick & Snare", trackKeys: ["Kick"] }] }));
    expect(p.map((x) => x.kind)).toEqual(["stem", "stem", "master", "extra"]);
  });

  it("exclusion is the complement of inclusion", () => {
    const drums = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                    Backing: { trackKeys: [], computed: true } } }))[0];
    expect(drums.include).toEqual(["Kick"]);
    expect(drums.exclude).toEqual(["Bass"]);
  });

  it("orders Backing last among stems", () => {
    const p = plan(m({ stems: { Backing: { trackKeys: [], computed: true },
                                Drums: { trackKeys: ["Kick"] } } }));
    expect(p.filter((x) => x.kind === "stem").map((x) => x.name)).toEqual(["Drums", "Backing"]);
  });

  it("the master pass excludes nothing", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    const master = p.find((x) => x.kind === "master")!;
    expect(master.exclude).toEqual([]);
    expect([...master.include].sort()).toEqual(["Bass", "Kick"]);
  });

  it("applies the suffix to stem filenames", () => {
    const p = plan(m({ song: "Learning to Feel",
      stems: { "Arturia - Played": { trackKeys: ["Kick"], suffix: " Jup Sync Lead" },
               Backing: { trackKeys: [], computed: true } },
      extras: [{ name: "Kick & Snare", trackKeys: ["Kick"] }] }));
    expect(p[0].outputName).toBe("Learning to Feel (Arturia - Played) Jup Sync Lead.wav");
    expect(p.find((x) => x.kind === "extra")!.outputName)
      .toBe("Learning to Feel (Kick & Snare).wav");
  });

  it("Backing includes exactly the unclaimed tracks", () => {
    const p = plan(m({ stems: { Drums: { trackKeys: ["Kick"] },
                                Backing: { trackKeys: [], computed: true } } }));
    expect(p[1].include).toEqual(["Bass"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/plan.test.ts`
Expected: FAIL — cannot resolve `../src/plan.js`.

- [ ] **Step 3: Implement the planner**

Create `src/plan.ts`:

```ts
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
  if ("Backing" in m.stems) stemNames.push("Backing");

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/plan.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add extensions/stem-export/src/plan.ts extensions/stem-export/test/plan.test.ts
git commit -m "feat: render planner with per-pass exclusion sets"
```

---

### Task 6: Audio — WAV, loudness, gain, null test

**Files:**
- Create: `extensions/stem-export/src/audio.ts`
- Test: `extensions/stem-export/test/audio.test.ts`

**Interfaces:**

```ts
export class SumMismatch extends Error {}
export interface Audio { channels: Float64Array[]; sampleRate: number; frames: number }
export function readWav(path: string): Audio;              // PCM 16/24/32-int and 32-float
export function writeWav24(path: string, a: Audio): void;
export function sumAudio(items: readonly Audio[]): Audio;  // throws SumMismatch
export function integratedLufs(a: Audio): number;          // ITU-R BS.1770-4, gated
export function truePeakDb(a: Audio): number;              // sample peak is sufficient here
export function gainFor(a: Audio, targetLufs: number, ceilingDb: number): number;
export function applyGain(a: Audio, gainDb: number): Audio;
export function nullResidualDb(stems: readonly Audio[], master: Audio, gainDb: number): number;
```

**Loudness.** Implement BS.1770-4: a two-stage K-weighting filter (high-shelf then
high-pass) as biquads with the standard coefficients for 48 kHz, mean square over 400 ms
blocks with 75% overlap, channel weights 1.0 for L/R, absolute gate at −70 LUFS, then a
relative gate at −10 LU below the ungated mean. Our use is **relative** — measure, then move
to a target — so the decisive tests are the relative ones.

Write no WAV parser dependency; the format subset Live emits is small and a parser is ~60
lines. Reject anything that is not PCM or IEEE float with a clear error.

- [ ] **Step 1: Write the failing tests**

Create `test/audio.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGain, gainFor, integratedLufs, nullResidualDb, readWav, SumMismatch,
         sumAudio, truePeakDb, writeWav24, type Audio } from "../src/audio.js";

function tone(freq = 1000, secs = 3, rate = 48000, amp = 0.1, chans = 2): Audio {
  const frames = Math.floor(secs * rate);
  const channels = Array.from({ length: chans }, () => {
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    return out;
  });
  return { channels, sampleRate: rate, frames };
}
const dir = () => mkdtempSync(join(tmpdir(), "sk-audio-"));

describe("audio", () => {
  it("round-trips a wav through disk", () => {
    const p = join(dir(), "a.wav");
    const a = tone();
    writeWav24(p, a);
    const b = readWav(p);
    expect(b.sampleRate).toBe(48000);
    expect(b.frames).toBe(a.frames);
    expect(b.channels[0][1000]).toBeCloseTo(a.channels[0][1000], 4);
  });

  it("sums sample-accurately", () => {
    const a = tone(220), b = tone(660);
    const s = sumAudio([a, b]);
    expect(s.channels[0][500]).toBeCloseTo(a.channels[0][500] + b.channels[0][500], 10);
  });

  it("rejects a sample-rate mismatch", () => {
    // Review Focus 4: silently resampling would make the null test lie.
    expect(() => sumAudio([tone(440, 1, 48000), tone(440, 1, 44100)])).toThrow(SumMismatch);
  });

  it("rejects a length mismatch", () => {
    expect(() => sumAudio([tone(440, 2), tone(440, 1.5)])).toThrow(SumMismatch);
  });

  it("rejects a channel-count mismatch", () => {
    expect(() => sumAudio([tone(440, 1, 48000, 0.1, 2), tone(440, 1, 48000, 0.1, 1)]))
      .toThrow(SumMismatch);
  });

  it("loudness tracks gain changes one-for-one", () => {
    // The property our normalisation actually depends on.
    const base = integratedLufs(tone());
    expect(integratedLufs(applyGain(tone(), -6))).toBeCloseTo(base - 6, 1);
    expect(integratedLufs(applyGain(tone(), +3))).toBeCloseTo(base + 3, 1);
  });

  it("measures a 1 kHz sine near its sample level", () => {
    // K-weighting is ~0 dB at 1 kHz, so a -20 dBFS sine reads close to -23 LUFS
    // (-20 dBFS peak is -23 dBFS RMS for a sine).
    const amp = Math.pow(10, -20 / 20);
    expect(integratedLufs(tone(1000, 3, 48000, amp))).toBeCloseTo(-23, 1);
  });

  it("gainFor hits the target when headroom allows", () => {
    const a = tone(1000, 3, 48000, 0.5);
    const g = gainFor(a, -18, -6);
    expect(integratedLufs(applyGain(a, g))).toBeCloseTo(-18, 1);
  });

  it("gainFor is clamped by the true-peak ceiling", () => {
    const quiet = tone(1000, 3, 48000, 0.001);
    const g = gainFor(quiet, -18, -6);
    expect(truePeakDb(applyGain(quiet, g))).toBeLessThanOrEqual(-6 + 0.01);
  });

  it("nulls to silence for a true partition", () => {
    const a = tone(220), b = tone(660);
    expect(nullResidualDb([a, b], sumAudio([a, b]), 0)).toBeLessThan(-60);
  });

  it("does not null when a stem is missing", () => {
    const a = tone(220), b = tone(660);
    expect(nullResidualDb([a], sumAudio([a, b]), 0)).toBeGreaterThan(-60);
  });

  it("accounts for the applied gain", () => {
    const a = tone(220);
    expect(nullResidualDb([applyGain(a, -8.8)], a, -8.8)).toBeLessThan(-60);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/audio.test.ts`
Expected: FAIL — cannot resolve `../src/audio.js`.

- [ ] **Step 3: Implement the audio module**

Create `src/audio.ts` satisfying the interfaces above.

Implementation notes the implementer needs:

- **WAV parsing.** Walk RIFF chunks; read `fmt ` for `audioFormat` (1 = PCM, 3 = IEEE float),
  `numChannels`, `sampleRate`, `bitsPerSample`; read `data`. De-interleave into one
  `Float64Array` per channel, scaling ints by `1 / 2^(bits-1)`. Throw a clear `Error` for any
  other `audioFormat`. Do not assume `data` is the second chunk — Live writes others.
- **Writing.** 24-bit PCM, little-endian, clamped to `[-1, 1 - 2^-23]`.
- **K-weighting biquads at 48 kHz** (BS.1770-4):
  - Stage 1 high shelf: `b = [1.53512485958697, -2.69169618940638, 1.19839281085285]`,
    `a = [1, -1.69065929318241, 0.73248077421585]`
  - Stage 2 high pass: `b = [1.0, -2.0, 1.0]`, `a = [1, -1.99004745483398, 0.99007225036621]`
  - For a non-48 kHz input, throw rather than silently mis-measuring; Live exports at the
    Set's rate and the author's is 48 kHz.
- **Gating.** 400 ms blocks, 100 ms hop. Block loudness
  `-0.691 + 10*log10(sum_ch(G_ch * meanSquare_ch))` with `G = 1.0` for L and R. Drop blocks
  below `-70`; compute the mean of the survivors; drop blocks below `that - 10`; the
  integrated value is `-0.691 + 10*log10` of the mean of what remains.
- `gainFor` returns `min(target - integratedLufs(a), ceilingDb - truePeakDb(a))`.
- `nullResidualDb` divides the stem sum by the applied gain before subtracting the master,
  then returns `truePeakDb` of the difference. Throw `SumMismatch` if shapes differ.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/audio.test.ts`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add extensions/stem-export/src/audio.ts extensions/stem-export/test/audio.test.ts
git commit -m "feat: wav io, BS.1770 loudness, per-song gain, null test"
```

---

### Task 7: Run engine — mutes, master bypass, watch, finalize

**Files:**
- Create: `extensions/stem-export/src/run.ts`
- Create: `extensions/stem-export/src/live.ts`
- Test: `extensions/stem-export/test/run.test.ts`

**Interfaces:**

```ts
// live.ts — the only module that touches the SDK. Everything else takes these interfaces.
export interface LiveTrack { key: string; setMute(v: boolean): void; getMute(): boolean }
export interface LiveMasterDevice { name: string; isEnabled(): Promise<boolean>;
                                    setEnabled(v: boolean): Promise<void> }
export interface LiveBridge {
  tracks(): Promise<LiveTrack[]>;
  masterDevices(): Promise<LiveMasterDevice[]>;
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
}
export function bridgeFromContext(context: ExtensionContext<"1.0.0">, snapshot: SongSnapshot): LiveBridge;

// run.ts
export interface AuthorState { mutes: Record<string, boolean>; masterEnabled: Record<string, boolean> }
export interface RunState {
  song: string; passIndex: number; passes: Pass[];
  author: AuthorState; collected: Record<string, string>;  // passName -> temp file path
}
export function runStatePath(storageDir: string): string;
export function saveRunState(s: RunState, path: string): void;
export function loadRunState(path: string): RunState | null;
export function clearRunState(path: string): void;

export async function beginRun(b: LiveBridge, passes: Pass[], song: string): Promise<RunState>;
export async function applyPass(b: LiveBridge, s: RunState): Promise<void>;
export function advance(s: RunState): RunState;
export async function restoreAuthorState(b: LiveBridge, s: RunState): Promise<void>;
export function isStemRender(file: string): boolean;
export function finalize(s: RunState, m: Manifest, outDir: string):
  { files: string[]; appliedGainDb: number; residualDb: number | null; ok: boolean };
```

**Review Focus 2 — author state is sacred.** `beginRun` writes `RunState` (including the
captured `author` block) to `storageDir` *before* mutating anything, so a crash still leaves a
restorable record. `restoreAuthorState` must be callable from a cold start with only that file.

**Review Focus 3 — ignore foreign files.** `isStemRender` accepts only `.wav`/`.aif`/`.aiff`,
case-insensitively, and rejects `.asd`, dotfiles, and anything still being written (size 0).

**Review Focus 5 — path safety.** `finalize` writes under `outDir` using `safeName()` from
`manifest.ts` for both the song folder and every filename.

- [ ] **Step 1: Resolve the sidechain-tap gap**

The SDK's `Device` exposes only `name` and `parameters`; there is no tap-point accessor.
Investigate whether a sidechain source is reachable — inspect `device.parameters` names on a
real ducked track in Live via the spike command, and check `DeviceParameter.valueItems`.

Record the finding in `docs/superpowers/notes/sidechain-taps.md`. **If taps are not reachable,
the `post-mixer-key` rule cannot fire**; in that case Task 4's validator keeps the rule and the
tests (they pass an explicit tap list), `bridgeFromContext` returns `[]`, and the note states
plainly that this check is unavailable until the SDK exposes routing. Do not fake it.

- [ ] **Step 2: Write the failing tests**

Create `test/run.test.ts`. Use a fake `LiveBridge` backed by a plain object — no SDK needed.

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav24 } from "../src/audio.js";
import type { Pass } from "../src/plan.js";
import { advance, applyPass, beginRun, finalize, isStemRender, loadRunState,
         restoreAuthorState, runStatePath, saveRunState } from "../src/run.js";

function fakeBridge(names: string[], muted: string[] = [], master: string[] = []) {
  const mutes = new Map(names.map((n) => [n, muted.includes(n)]));
  const enabled = new Map(master.map((n) => [n, true]));
  return {
    bridge: {
      tracks: async () => names.map((key) => ({
        key,
        getMute: () => mutes.get(key)!,
        setMute: (v: boolean) => void mutes.set(key, v),
      })),
      masterDevices: async () => master.map((name) => ({
        name,
        isEnabled: async () => enabled.get(name)!,
        setEnabled: async (v: boolean) => void enabled.set(name, v),
      })),
      transaction: async <T,>(fn: () => T | Promise<T>) => fn(),
    },
    mutes, enabled,
  };
}

const pass = (name: string, include: string[], exclude: string[]): Pass =>
  ({ kind: "stem", name, include, exclude, outputName: `Song (${name}).wav` });

describe("run engine", () => {
  it("captures author state and bypasses master before mutating", async () => {
    const { bridge, enabled } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song");
    expect(s.author.mutes).toEqual({ Kick: false, Bass: true });
    expect(s.author.masterEnabled).toEqual({ Limiter: true });
    expect(enabled.get("Limiter")).toBe(false);
  });

  it("applyPass mutes exactly the excluded tracks", async () => {
    const { bridge, mutes } = fakeBridge(["Kick", "Bass"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song");
    await applyPass(bridge, s);
    expect(mutes.get("Kick")).toBe(false);
    expect(mutes.get("Bass")).toBe(true);
  });

  it("restores author state exactly, including pre-existing mutes", async () => {
    // Review Focus 2.
    const { bridge, mutes, enabled } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song");
    await applyPass(bridge, s);
    await restoreAuthorState(bridge, s);
    expect(mutes.get("Kick")).toBe(false);
    expect(mutes.get("Bass")).toBe(true);
    expect(enabled.get("Limiter")).toBe(true);
  });

  it("run state survives a cold start so a crash is recoverable", async () => {
    // Review Focus 2.
    const dir = mkdtempSync(join(tmpdir(), "sk-run-"));
    const { bridge, mutes } = fakeBridge(["Kick", "Bass"], ["Bass"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song");
    saveRunState(s, runStatePath(dir));
    await applyPass(bridge, s);
    const recovered = loadRunState(runStatePath(dir))!;
    await restoreAuthorState(bridge, recovered);
    expect(mutes.get("Bass")).toBe(true);
    expect(mutes.get("Kick")).toBe(false);
  });

  it("advance moves to the next pass", () => {
    const s = { song: "Song", passIndex: 0, passes: [pass("A", [], []), pass("B", [], [])],
                author: { mutes: {}, masterEnabled: {} }, collected: {} };
    expect(advance(s).passIndex).toBe(1);
  });

  it("finalize keeps output inside outDir even for a hostile song name", () => {
    // Review Focus 5: the song name reaches the filesystem.
    const dir = mkdtempSync(join(tmpdir(), "sk-out-"));
    const renders = mkdtempSync(join(tmpdir(), "sk-renders-"));

    // One real stem render and one master reference, so finalize actually runs.
    const tone = (freq: number) => {
      const frames = 48000, ch = new Float64Array(frames);
      for (let i = 0; i < frames; i++) ch[i] = 0.1 * Math.sin((2 * Math.PI * freq * i) / 48000);
      return { channels: [ch, Float64Array.from(ch)], sampleRate: 48000, frames };
    };
    const stemPath = join(renders, "stem.wav");
    const masterPath = join(renders, "master.wav");
    writeWav24(stemPath, tone(220));
    writeWav24(masterPath, tone(220));

    const passes: Pass[] = [
      { kind: "stem", name: "Drums", include: [], exclude: [], outputName: "AC/DC (Drums).wav" },
      { kind: "master", name: "M", include: [], exclude: [], outputName: "AC/DC (MASTER).wav" },
    ];
    const state = { song: "AC/DC", passIndex: 2, passes,
                    collected: { Drums: stemPath, M: masterPath },
                    author: { mutes: {}, masterEnabled: {} } };
    const man = { song: "AC/DC", targetLufs: -18, truePeakCeilingDb: -6,
                  appliedGainDb: null, stems: { Drums: { trackKeys: [] } }, extras: [] };

    const out = finalize(state as never, man as never, dir);
    expect(out.files.length).toBeGreaterThan(0);
    for (const f of out.files) {
      expect(f.startsWith(dir)).toBe(true);
      expect(f).not.toContain(`${dir}/AC/DC`);   // "/" must not have created a nested dir
    }
  });

  it("ignores files that are not renders", () => {
    // Review Focus 3.
    expect(isStemRender("Song (Drums).wav")).toBe(true);
    expect(isStemRender("Song (Drums).WAV")).toBe(true);
    expect(isStemRender("Song (Drums).aif")).toBe(true);
    expect(isStemRender("Song (Drums).wav.asd")).toBe(false);
    expect(isStemRender(".DS_Store")).toBe(false);
    expect(isStemRender("notes.txt")).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL — cannot resolve `../src/run.js`.

- [ ] **Step 4: Implement `run.ts` and `live.ts`**

`live.ts` is the only SDK-aware module. `bridgeFromContext` maps `snapshot` keys onto the
SDK's `Track` objects by matching the same group-path-plus-ordinal rule from Task 2, wraps
every mutation in `context.withinTransaction`, and reads Master device enablement via
`device.parameters.find(p => p.name === "Device On")`.

`run.ts` implements the interfaces above, using `audio.ts` for `finalize`:
read every collected stem render, sum them, compute one `gainFor` against
`m.targetLufs`/`m.truePeakCeilingDb`, apply that same gain to every stem **and** extra, write
them under `<outDir>/<safeName(song)>/` with extras in `Extras/`, then null-test the stem
passes against the Master reference and return the residual.

- [ ] **Step 5: Run the full suite**

Run: `cd extensions/stem-export && npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add extensions/stem-export/src extensions/stem-export/test docs/superpowers/notes
git commit -m "feat: run engine with author-state capture, pass application, finalize"
```

---

### Task 8: Mapping UI

**Files:**
- Create: `extensions/stem-export/src/ui/mapping.html`
- Create: `extensions/stem-export/src/ui/protocol.ts`
- Test: `extensions/stem-export/test/protocol.test.ts`

**Interfaces:**

```ts
// protocol.ts — the typed contract across the webview boundary
export interface MappingRequest {
  song: string; tempDirectory: string;
  tracks: { key: string; name: string; depth: number; isGroup: boolean;
            muted: boolean; devices: string[] }[];
  stemNames: string[];
  current: { assignments: Record<string, string>; extras: { name: string; trackKeys: string[] }[] };
  findings: Finding[];
  outputPreview: { stem: string; count: number; filename: string }[];
}
export interface MappingResponse {
  cancelled: boolean;
  assignments: Record<string, string>;         // trackKey -> stem
  extras: { name: string; trackKeys: string[] }[];
}
export function encodeRequest(r: MappingRequest): string;   // data: URL payload
export function parseResponse(raw: string): MappingResponse;  // throws on malformed
```

The HTML is adapted from `.context/mockup/index.html`, **restyled to Live's own theme** using
the tokens from the SDK's `modal-dialog` example (`--p-live-ui-bg: hsl(0,0%,21%)`,
`--p-live-control-bg: hsl(0,0%,16%)`, `--p-live-input-bg: hsl(0,0%,12%)`,
`--p-live-text-primary: hsl(0,0%,71%)`, `--p-live-accent-primary: hsl(31,100%,67%)`).
Drop the board view — table only, per the decision on 2026-10-09.

It must show: the track table with group indentation and a single stem dropdown per row;
unassigned rows reading `→ Backing (unclaimed)`; the validation findings; the output preview
with exact filenames; the `Extras` dialog; and **the temp directory path with a copy button**,
since the author sets Live's export destination to it.

Return via the host handler, exactly as the SDK example does:

```js
function closeWithResult(result) {
  const msg = { method: "close_and_send", params: [JSON.stringify(result)] };
  if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(msg);
  else if (window.chrome?.webview) window.chrome.webview.postMessage(msg);
}
```

- [ ] **Step 1: Write the failing protocol tests**

Create `test/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeRequest, parseResponse, type MappingRequest } from "../src/ui/protocol.js";

const req: MappingRequest = {
  song: "Learning to Feel", tempDirectory: "/tmp/x",
  tracks: [{ key: "Drums/Kick", name: "Kick", depth: 1, isGroup: false, muted: false, devices: [] }],
  stemNames: ["Drums", "Backing"],
  current: { assignments: { "Drums/Kick": "Drums" }, extras: [] },
  findings: [], outputPreview: [],
};

describe("mapping protocol", () => {
  it("encodes to something embeddable in a data URL", () => {
    const s = encodeRequest(req);
    expect(() => new URL(`data:text/html,${s}`)).not.toThrow();
    expect(decodeURIComponent(s)).toContain("Learning to Feel");
  });

  it("survives names with quotes and ampersands", () => {
    const tricky = { ...req, song: `AC/DC "Live" & Loud` };
    expect(decodeURIComponent(encodeRequest(tricky))).toContain(`AC/DC "Live" & Loud`);
  });

  it("parses a cancelled response", () => {
    expect(parseResponse(JSON.stringify({ cancelled: true })).cancelled).toBe(true);
  });

  it("parses assignments and extras", () => {
    const r = parseResponse(JSON.stringify({
      cancelled: false, assignments: { "Drums/Kick": "Drums" },
      extras: [{ name: "Kick & Snare", trackKeys: ["Drums/Kick"] }],
    }));
    expect(r.assignments["Drums/Kick"]).toBe("Drums");
    expect(r.extras[0].name).toBe("Kick & Snare");
  });

  it("throws on malformed input rather than returning a half-built mapping", () => {
    expect(() => parseResponse("not json")).toThrow();
    expect(() => parseResponse(JSON.stringify({ assignments: "nope" }))).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/protocol.test.ts`
Expected: FAIL — cannot resolve `../src/ui/protocol.js`.

- [ ] **Step 3: Implement `protocol.ts` and `mapping.html`**

`encodeRequest` returns `encodeURIComponent` of the full HTML with the request JSON injected
into a `<script>` tag as `window.__REQUEST__`. `parseResponse` validates shape and throws a
descriptive `Error` on anything unexpected.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/protocol.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Verify the dialog renders**

Open `src/ui/mapping.html` directly in a browser with a stubbed `window.__REQUEST__` and
screenshot it to `.context/ui-check.png`. Confirm: group indentation reads correctly, the
dropdown lists every stem, unassigned rows are visibly italic, and the temp path is visible.

- [ ] **Step 6: Commit**

```bash
git add extensions/stem-export/src/ui extensions/stem-export/test/protocol.test.ts
git commit -m "feat: mapping webview in Live's native theme"
```

---

### Task 9: Commands, wiring, packaging, and the README

**Files:**
- Modify: `extensions/stem-export/src/extension.ts`
- Create: `README.md` (repo root)
- Test: `extensions/stem-export/test/commands.test.ts`

**Interfaces:**
- Consumes: every module above.
- Produces: the registered commands, a built `.ablx`, and the documentation.

Commands:

| id | Title | Does |
|---|---|---|
| `stem-export.configure` | Stem Export… | Snapshot → load/seed manifest → mapping dialog → validate → block on errors → save manifest → `beginRun` → `applyPass(0)` → start watching `tempDirectory` |
| `stem-export.next` | Stem Export: Next Pass | Manual advance (override, and the fallback loop if the spike failed) |
| `stem-export.finish` | Stem Export: Finish | `restoreAuthorState` → `finalize` → results dialog showing the output path and the null residual |
| `stem-export.abort` | Stem Export: Abort | `restoreAuthorState` → `clearRunState`, leaving the Set exactly as found |

Register all four on both `AudioTrack` and `MidiTrack` scopes.

- [ ] **Step 1: Write the failing test**

Create `test/commands.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { activate } from "../src/extension.js";

function fakeActivation() {
  const commands = new Map<string, Function>();
  const menu: { scope: string; title: string; id: string }[] = [];
  return {
    commands, menu,
    context: {
      commands: { registerCommand: (id: string, cb: Function) => void commands.set(id, cb) },
      ui: {
        registerContextMenuAction: async (scope: string, title: string, id: string) =>
          void menu.push({ scope, title, id }),
        showModalDialog: vi.fn(),
        withinProgressDialog: vi.fn(),
      },
      environment: { storageDirectory: "/tmp/s", tempDirectory: "/tmp/t" },
      application: { song: { tracks: [], mainTrack: { name: "Main", mute: false,
                     groupTrack: null, devices: [] } } },
      withinTransaction: async (fn: Function) => fn(),
    },
  };
}

describe("extension activation", () => {
  it("registers all four commands", () => {
    const f = fakeActivation();
    activate(f.context as never);
    expect([...f.commands.keys()].sort()).toEqual(
      ["stem-export.abort", "stem-export.configure",
       "stem-export.finish", "stem-export.next"].sort());
  });

  it("registers context menu actions on both track scopes", () => {
    const f = fakeActivation();
    activate(f.context as never);
    expect(new Set(f.menu.map((m) => m.scope))).toEqual(new Set(["AudioTrack", "MidiTrack"]));
  });
});
```

> **Note:** `activate` takes the real `ActivationContext` and calls `initialize`. Refactor so
> the testable part is `registerAll(context)`, and `activate` is the two-line wrapper that
> calls `initialize` then `registerAll`. Point this test at `registerAll`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring**

- [ ] **Step 4: Run the full suite and build the package**

```bash
cd extensions/stem-export && npm test && npm run build && npm run package
```

Expected: all tests pass and a `.ablx` is produced.

- [ ] **Step 5: End-to-end on a real song**

Open a real project in Live Beta. Run **Stem Export…**, map a handful of tracks, export two
passes to the temp directory, run **Finish**. Confirm: files are correctly named, one gain is
applied to all of them, the null residual is reported, and your original mute state and
Master devices come back exactly as they were.

- [ ] **Step 6: Write the README**

Create `README.md` at the repo root. Two parts, both required by the brief.

**Part 1 — Installing into Ableton.** State plainly that Extensions need **Live 12 Suite Beta
12.4.5+**; stable 12.4.6 has no Extension Host. Cover: joining the beta, where the `.ablx`
comes from, installing via Settings → Extensions (drag the `.ablx` in, or Install Extension),
and — for development — enabling Developer Mode plus `npm start` with `EXTENSION_HOST_PATH`.

**Part 2 — The process**, not a feature manual. Describe the workflow: finish the track, run
Stem Export, decide what you'll play live versus what runs as backing, let `Backing` collect
the remainder, set Live's export destination to the temp path once, Export repeatedly, Finish,
then drag the output folder into `Content/Stems/`. Explain *why* stems are premaster, why one
gain is applied across a song, and what the null test proves. Keep it to the shape of the
process; the tool explains its own buttons.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: command wiring, packaging, and README"
```
