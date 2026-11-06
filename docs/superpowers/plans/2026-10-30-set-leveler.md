# Set Leveler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Max for Live device that levels a DJ set's Session clips to one target with clip gain, with layers following their host and an undo that restores every gain exactly.

**Architecture:** A `v8` object in the device reads and writes clips through the Live Object Model. A `node.script` process owns everything else: file analysis, roles, the plan, snapshots. A `jweb` window is a thin view of state pushed by Node. All logic lives in pure TypeScript modules tested against fakes, bundled by esbuild into one file.

**Tech Stack:** TypeScript, vitest and esbuild (same as `extensions/stem-export`), Node 22.18 (bundled with Max in Live 12.4.15), Max `v8`, `node.script`, `jweb`, macOS `afconvert`.

**Spec:** `docs/superpowers/specs/2026-10-30-set-leveler-design.md`, screen in `docs/superpowers/specs/2026-10-30-set-leveler-mockup.html`

## Global Constraints

- Session view only. Arrangement is only read, to suggest hosts.
- Only Session clip gain is ever written. Never write audio files or `.als` files, never save the Set.
- Target default **-12** LUFS. Peak limit default **+2** dB.
- Loudness is the 95th percentile of short-term LUFS, over the part of the file the clip plays.
- Nothing is written until Apply. Apply saves its snapshot to disk before the first write.
- The tool never lowers the target by itself.
- No loudness or peak columns on the screen.
- Everything goes under `max-for-live/set-leveler/`. Don't rename the repo or touch `extensions/stem-export/`.
- No dependency the owner must install. The device runs on what ships with Live.

## Review Focus

- A clip is moved, deleted or swapped between Analyze and Apply: Apply rescans, skips that clip, and says so. (Task 4)
- The Set has never been saved, so it has no path: Apply refuses and asks to save first, because Undo couldn't find its snapshot. (Task 4)
- A source file is missing, offline or undecodable: that clip is left alone and listed, and the run finishes. (Task 2 and Task 4)
- Live crashes part-way through Apply: after reopening the unsaved Set, Undo still works from the snapshot on disk. (Task 4)
- Analyze runs again after Apply: every change reads about 0 dB, not a second push. (Task 3)

---

### Task 1: Spike and device builder (gate)

Everything after this assumes what it proves. **Stop after Step 4 and report to the owner if any check fails.**

**Files:**
- Create: `max-for-live/set-leveler/scripts/build-amxd.mjs`
- Create: `max-for-live/set-leveler/spike/` (`spike.patcher.mjs`, `spike-bridge.js`, `spike-node.js`, `spike-ui.html`)
- Create: `docs/superpowers/notes/set-leveler-spike.md`

**Interfaces:**
- Produces: `writeAmxd(outPath: string, patcher: object): void` from `scripts/build-amxd.mjs`. Task 5 uses it. Produces `GAIN_TABLE` values and the shape of `warp_markers` for Task 2, and undo behaviour for the notes.

- [ ] **Step 1: Implement `writeAmxd`**

Header bytes, confirmed against existing devices on this machine: ASCII `ampf`, `04 00 00 00`, ASCII `aaaa` (Audio Effect), ASCII `meta`, `04 00 00 00`, `00 00 00 00`, ASCII `ptch`, UInt32LE length of the JSON, then the JSON `{"patcher": ...}`. Test: read back a reference device's header (`ClipLaunchLink.amxd` uses the same layout with `mmmm`) by eye, not in the suite.

- [ ] **Step 2: Build the spike device into `max-for-live/set-leveler/dist/spike/`**

A patcher with `plugin~` to `plugout~`, a `live.text` button for each action, `v8 spike-bridge.js`, `node.script spike-node.js`, and a subpatcher holding `jweb` that a button opens with `pcontrol`. Actions on Live's selected clip (`live_set view detail_clip`):
- **Read:** post `gain`, `gain_display_string`, `file_path`, `warping`, `looping`, `loop_start`, `loop_end`, `warp_markers`.
- **Sweep:** remember `gain`, set 0.00 to 1.00 in 0.01 steps, record each `gain_display_string`, restore, and send the results to Node, which writes `/tmp/set-leveler-spike.json`.
- **Write three:** set gain to three different values, one per message, to count Cmd-Z entries.
- **UI:** the `jweb` page shows a button, its click reaches Node, and Node's reply changes the page.

- [ ] **Step 3: Owner runs it in Live, on a throwaway Set with one warped and one unwarped audio clip**

Ask the owner to drag `dist/spike/Set Leveler Spike.amxd` onto an audio track and press each button, then report what they see. Give them numbered steps.

- [ ] **Step 4: Record results in `docs/superpowers/notes/set-leveler-spike.md`**

Must pass: device loads, `node.script` finds its file beside the `.amxd`, `v8` reads and sets gain, the `jweb` window round-trips, and the sweep file exists. Must record: gain table, top of the dB range, `warp_markers` shape and whether its times are seconds, the same fields on an unwarped clip, and Cmd-Z entries per write.

- [ ] **Step 5: Commit**

```bash
git add max-for-live/set-leveler docs/superpowers/notes/set-leveler-spike.md
git commit -m "Set Leveler spike: generated device reads and writes clip gain in Live"
```

---

### Task 2: Measuring

**Files:**
- Create: `max-for-live/set-leveler/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/types.ts`, `src/gain-map.ts`, `src/measure.ts`
- Test: `test/gain-map.test.ts`, `test/measure.test.ts`

(`src/` and `test/` are under `max-for-live/set-leveler/` throughout.)

**Interfaces:**
- Consumes: `readWav`, `kWeighting`, `truePeakDb`, `Audio` from `../../../extensions/stem-export/src/audio.js`, by relative import, bundled by esbuild.
- Produces, in `src/types.ts`:

```ts
export type ClipKey = string; // `${trackIndex}:${slotIndex}`
export interface WarpMarker { beatTime: number; sampleTime: number }
export interface SessionClip {
  key: ClipKey; trackIndex: number; slotIndex: number; trackName: string; name: string;
  filePath: string; rawGain: number; warping: boolean;
  loopStart: number; loopEnd: number; warpMarkers: WarpMarker[];
}
export interface ArrangementClip { filePath: string; start: number; end: number }
export interface LiveScan { setPath: string; session: SessionClip[]; arrangement: ArrangementClip[]; layerCandidates: { trackIndex: number; trackName: string }[] }
export interface Measure { loudestLufs: number | null; peakDb: number | null } // file level, before clip gain
```

- Produces: `rawToDb(raw: number): number`, `dbToRaw(db: number): { raw: number; clamped: boolean }` in `src/gain-map.ts`. `loudestStretch(a: Audio): number | null`, `playedSeconds(clip: SessionClip, fileSeconds: number): { start: number; end: number }`, `loadAudio(path: string): Audio`, `measureClip(clip: SessionClip): Measure` in `src/measure.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// gain-map: every GAIN_TABLE entry from the spike round-trips
it("round-trips", () => { for (const [raw, db] of GAIN_TABLE) expect(rawToDb(dbToRaw(db).raw)).toBeCloseTo(db, 1); });
it("clamps above the top of the range", () => expect(dbToRaw(MAX_DB + 6).clamped).toBe(true));

// measure, using stem export's tone() helper shape
it("reads a steady 0.1 amp stereo 1 kHz tone at about -20.7", () => expect(loudestStretch(tone(1000, 10, 48000, 0.1))).toBeCloseTo(-20.7, 0));
it("a long quiet intro doesn't read as quiet", () => {
  const a = concat(tone(1000, 25, 48000, 0.01), tone(1000, 5, 48000, 0.1));
  expect(loudestStretch(a)).toBeGreaterThan(-22);
});
it("silence reads null", () => expect(loudestStretch(tone(1000, 10, 48000, 0))).toBeNull());
it("under 3 seconds reads null", () => expect(loudestStretch(tone(1000, 2))).toBeNull());
it("maps beats to seconds through warp markers", () =>
  expect(playedSeconds(warped({ loopStart: 2, loopEnd: 6, markers: [[0, 0], [8, 4]] }), 60)).toEqual({ start: 1, end: 3 }));
it("measures the whole file for an unwarped clip", () =>
  expect(playedSeconds(unwarped(), 60)).toEqual({ start: 0, end: 60 }));
it("clamps the region to the file", () =>
  expect(playedSeconds(warped({ loopStart: 0, loopEnd: 400, markers: [[0, 0], [8, 4]] }), 60).end).toBe(60));
it.skipIf(process.platform !== "darwin")("decodes an m4a through afconvert", /* tone to wav, afconvert to m4a, loadAudio */);
it("a missing file measures as nulls instead of throwing", () =>
  expect(measureClip(clipAt("/nope.wav"))).toEqual({ loudestLufs: null, peakDb: null }));
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd max-for-live/set-leveler && npm install && npx vitest run`. Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`package.json`: dev dependencies `@types/node`, `esbuild`, `typescript`, `vitest`, same versions as stem-export. `GAIN_TABLE` comes from the spike's sweep; interpolate linearly between entries.

`loudestStretch`: K-weight with `kWeighting`, 3 s window, 100 ms hop, `-0.691 + 10 log10(sum over channels of mean square)`. Keep values above -70 LUFS, sort, take index `floor(0.95 * n)`. `null` if none. `audio.ts` keeps its `biquad` private, so export it from there only if that's a one-word change; otherwise copy the 10 lines.

`playedSeconds`: use the spike's finding for marker units. Interpolate between markers, extend the outer segments, clamp to the file. Fewer than 2 markers or `warping` false means the whole file.

`loadAudio`: `.wav` through `readWav`, falling back to `afconvert -f WAVE -d LEF32 <in> <tmp.wav>` (via `execFileSync`) if that throws or for any other extension. Delete the temp file.

`measureClip`: load, slice to `playedSeconds`, measure, return nulls on any error. Holds one file in memory at a time.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add max-for-live/set-leveler
git commit -m "Set Leveler: gain mapping and loudest-stretch measuring"
```

---

### Task 3: Roles and the plan

**Files:**
- Create: `src/roles.ts`, `src/plan.ts`, `scripts/als-tools.py`
- Create: `test/fixtures/halloween-layout.json`
- Test: `test/roles.test.ts`, `test/plan.test.ts`

**Interfaces:**
- Consumes: `SessionClip`, `ArrangementClip`, `ClipKey`, `Measure` from `src/types.ts`; `rawToDb`, `dbToRaw`.
- Produces:

```ts
// src/roles.ts
export type Role = { kind: "track" } | { kind: "layer"; host: ClipKey | null } | { kind: "leave" };
export function suggestHost(clip: SessionClip, scan: LiveScan, layerTracks: number[]): ClipKey | null;
export function resolveRoles(scan: LiveScan, layerTracks: number[], answers: Record<ClipKey, Role>): Map<ClipKey, Role>;

// src/plan.ts
export interface PlanRow { key: ClipKey; name: string; role: Role; changeDb: number | null; newRaw: number | null; clamped: boolean; unread: boolean }
export interface Plan {
  rows: PlanRow[]; tracks: number; layers: number; needAnswer: ClipKey[];
  biggestDown: number; biggestUp: number;
  weakest: { key: ClipKey; name: string; costDb: number; matchTarget: number } | null;
}
export function makePlan(clips: SessionClip[], roles: Map<ClipKey, Role>, measures: Map<ClipKey, Measure>, target: number, peakLimit?: number): Plan;
```

- [ ] **Step 1: Generate the fixture**

`python3 -I scripts/als-tools.py fixture "<Halloween .als>" > test/fixtures/halloween-layout.json`: a `LiveScan` with Session and Arrangement clips, keeping only file basenames. Parse as in `.context/recon/overlap_file.py`. Layer track: `TRACK C`.

- [ ] **Step 2: Write failing tests**

```ts
// roles, against the fixture
it.each([
  ["SEVEN DAYS VOCAL SAMPLES", "EPHEWHEN CAY"], ["GET BUSY", "EPHEWHEN CAY"],
  ["A YOUNGER ME VOCAL SAMPLES", "TWO GUYS"], ["EMPTY WITHOUT MUSIC VOX 1", "DEFUNK HEAD NOD"],
  ["EMPTY WITHOUT MUSIC VOX 2", "DEFUNK HEAD NOD"], ["SPACE TUNNEL BUILD 2", "DEFUNK HEAD NOD"],
  ["OPEN THAT DOOR VOCAL", "INTO INFINITY"], ["Aye Aye Kaptain", "WHERE TROUBLES MELT"],
])("suggests %s on %s", ...);
it.each(["DAYS GO BY VOX SAMPLES", "SPACE TUNNEL BUILD 1"])("%s is a tie, so no suggestion", ...);
it("no suggestion when the best file has two non-layer Session clips", ...);
it("no suggestion for a clip not in Arrangement", ...);
it("non-layer lanes start as tracks, layer lanes as layers", ...);
it("an answer beats a suggestion", ...);
it("a saved host that's gone, or stopped being a track, goes back to null", ...);

// plan, with real Halloween numbers. c(cur, peak) builds a 0 dB clip with that measure.
it("moves a track to the target", () => expect(row(c(-10.2, 4.0), -12).changeDb).toBeCloseTo(-1.8));
it("a layer takes its host's exact change", ...);    // host -8.5 at -12: layer change -3.5
it("an unanswered layer and a leave-alone clip don't change", ...);  // changeDb null
it("a layer on an unread host doesn't change", ...);
it("an unread track doesn't change and is flagged", ...);
it("flags the weakest link and what matching it costs", () => {
  const p = plan([c(-10.2, 4.0)], -12);
  expect(p.weakest!.costDb).toBeCloseTo(0.2); expect(p.weakest!.matchTarget).toBeCloseTo(-12.2);
});
it("no weakest link once nothing is over the limit", () => expect(plan([c(-10.2, 4.0)], -12.2).weakest).toBeNull());
it("layers can't be the weakest link", ...);
it("re-analyzing after Apply reads about 0 dB", ...); // measure unchanged, rawGain = newRaw from a first plan
it("flags a change the gain range can't reach", ...); // clamped true
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/roles.test.ts test/plan.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**

`suggestHost` algorithm: find the file's Arrangement clips. Sum their time overlap with Arrangement clips of every other file used by a non-layer Session clip, per file. Take the top file. Return `null` if there's no overlap, if the second is within 1 beat of it, or if the top file has more than one non-layer Session clip. Otherwise return that clip's key.

`makePlan`: for a track, current = `loudestLufs + rawToDb(rawGain)`, change = target − current, peak after = `peakDb + rawToDb(rawGain) + change`. `newRaw = dbToRaw(rawToDb(rawGain) + change).raw`. A layer's `changeDb` is its host's. Weakest = the track with the highest peak after, if above the limit: `costDb` = peak after − limit, `matchTarget` = target − `costDb`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`. Expected: PASS. If the fixture's Set has changed since the spec's count, update the expected hosts after checking them against `overlap_file.py`, and tell the owner.

- [ ] **Step 6: Commit**

```bash
git add max-for-live/set-leveler
git commit -m "Set Leveler: clip roles, host suggestions and the plan"
```

---

### Task 4: Undo and the controller

**Files:**
- Create: `src/store.ts`, `src/controller.ts`
- Test: `test/store.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Consumes: `resolveRoles`, `makePlan`, `measureClip`, types above.
- Produces:

```ts
// src/store.ts: files under baseDir/<sha1 of setPath>/
export interface SnapshotEntry { key: ClipKey; trackIndex: number; slotIndex: number; filePath: string; rawGain: number }
export class Store {
  constructor(baseDir: string, setPath: string);
  pushSnapshot(entries: SnapshotEntry[]): void; // temp file then rename
  latestSnapshot(): SnapshotEntry[] | null;
  dropLatestSnapshot(): void;
  loadAnswers(): { layerTracks: number[] | null; answers: Record<ClipKey, Role> };
  saveAnswers(layerTracks: number[], answers: Record<ClipKey, Role>): void;
}

// src/controller.ts
export interface LiveBridge { scan(): Promise<LiveScan>; setGain(trackIndex: number, slotIndex: number, raw: number): Promise<number> } // resolves with the value read back
export interface ViewState { /* phase, plan, target, needsLanes, candidates, canUndo, message, progress */ }
export class Controller {
  constructor(bridge: LiveBridge, baseDir: string, measure: (c: SessionClip) => Promise<Measure>, push: (s: ViewState) => void);
  analyze(): Promise<void>; setLayerTracks(t: number[]): void; setTarget(t: number): void; matchWeakest(): void;
  setRole(key: ClipKey, role: Role): void; apply(): Promise<void>; undo(): Promise<void>;
}
```

- [ ] **Step 1: Write failing tests**

```ts
it("apply saves the snapshot before the first write", ...);   // fake bridge's setGain asserts store.latestSnapshot() is populated
it("the snapshot covers exact raw gains of every clip it'll change", ...);
it("apply only writes rows with a change", ...);              // leave-alone, unanswered, unread are never written
it("apply rescans and skips a clip that moved or changed file", ...);  // message names the clip
it("apply refuses on a Set with no path", ...);               // zero writes, message says save first
it("apply reports a read-back mismatch", ...);
it("undo restores exact raw values and steps back through Applies", ...);
it("undo skips and lists a clip that no longer matches", ...);
it("undo works from a fresh Controller after a crash mid-apply", ...); // bridge throws on write 3, new Controller, undo restores all
it("undo with nothing to undo says so", ...);
it("a failed undo keeps its snapshot", ...);
it("changing the target doesn't re-measure", ...);
it("match weakest sets the target to matchTarget", ...);
it("an unreadable clip doesn't stop the run", ...);
it("answers survive a new Controller for the same Set", ...);
it("another Set gets its own snapshots and answers", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/store.test.ts test/controller.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/store.ts` and `src/controller.ts`**

`analyze` measures clips one at a time, awaiting between each and pushing progress. A clip matches a snapshot or plan entry when track index, slot index and file path all match. Undo compares every read-back to the stored raw value and drops the snapshot only if all writes matched, even when some clips were skipped.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add max-for-live/set-leveler
git commit -m "Set Leveler: snapshot undo and the run controller"
```

---

### Task 5: The device

No automated tests beyond the build: this is the thin layer on Max. The owner confirms it in Task 6.

**Files:**
- Create: `src/main.ts`, `device/bridge.js`, `device/ui.html`, `scripts/build.mjs`
- Test: `test/build.test.ts`

**Interfaces:**
- Consumes: `writeAmxd`, `Controller`, `LiveBridge`, `ViewState`.
- Produces: `npm run build` writes `dist/Set Leveler/` holding `Set Leveler.amxd`, `node-main.js`, `bridge.js`, `ui.html`. `npm run install-device` copies it to `~/Documents/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/Set Leveler/`.

- [ ] **Step 1: Write the failing build test**

```ts
it("writes an Audio Effect amxd whose JSON names all three files", () => {
  const b = readFileSync("dist/Set Leveler/Set Leveler.amxd");
  expect(b.subarray(0, 4).toString()).toBe("ampf"); expect(b.subarray(8, 12).toString()).toBe("aaaa");
  const json = JSON.parse(b.subarray(32).toString());
  // boxes include node.script node-main.js, v8 bridge.js, jweb with ui.html, plugin~ and plugout~
});
```

- [ ] **Step 2: Implement `device/bridge.js`**

Runs in `v8`. `scan`: walk `live_set tracks`, each `clip_slots`, skip empty slots and non-audio clips (`is_audio_clip`), and send one `clip <json>` message per clip, so no single message gets large. Do the same for `arrangement_clips`, then `scan_done <json with setPath and track names>`. `setgain <track> <slot> <raw>`: set `gain`, read it back, reply `gain_set <track> <slot> <value>`. It touches no other property.

- [ ] **Step 3: Implement `src/main.ts`**

`max-api` handlers joining messages into a `LiveScan` and resolving `LiveBridge` promises, with `measure` running `measureClip` after `setImmediate`. `baseDir` is `~/Library/Application Support/Set Leveler`. Node pushes `state <json>` to `jweb` after every change. Mark `max-api` external in esbuild; bundle everything else to CommonJS for node 22.

- [ ] **Step 4: Implement `device/ui.html`**

Copy the look and layout from the mockup, removing its data and logic. It renders `ViewState` and sends actions: Analyze, target, role dropdowns, Match it, See every clip, Undo, Apply. Add the three things the mockup leaves out: Analyze with progress, the first-run question ("Which tracks hold layers?" with a checkbox per track, Track C-style names not preselected), and a results line after Apply and Undo naming any skipped clips.

- [ ] **Step 5: Implement `scripts/build.mjs` and the patcher**

Use what the spike proved: `plugin~` to `plugout~`, a device-face button that opens the `jweb` window through the spike's method, and the wiring between `node.script`, `v8` and `jweb`.

- [ ] **Step 6: Build and run all tests**

Run: `npm run build && npx vitest run`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add max-for-live/set-leveler
git commit -m "Set Leveler: the device, bridge and screen"
```

---

### Task 6: Real test on a copy of the Set

**Files:**
- Modify: `scripts/als-tools.py` (add `compare`)
- Create: `max-for-live/set-leveler/README.md`

- [ ] **Step 1: Add `als-tools.py compare <a.als> <b.als>`**

Lists every audio clip whose `SampleVolume` differs, with track, slot and both values, and prints a total. Exit 0 only when there are no differences. Try it on two copies of the same Set, and confirm a clip changed by hand in a third copy gets listed.

- [ ] **Step 2: Owner tests on a copy**

Give the owner numbered steps: **Save a Copy** of the Halloween Set as `... TEST.als`, run `npm run install-device`, load the device on the copy, Analyze, answer the questions, Apply, confirm the gains changed, Undo, save.

- [ ] **Step 3: Verify Undo was exact**

Run: `python3 -I scripts/als-tools.py compare "<original>.als" "<... TEST>.als"`. Expected: 0 differences. If the owner changed the original since copying, compare with a backup taken at copy time.

- [ ] **Step 4: Owner applies again and listens to transitions**

Apply on the copy, save it as a new test copy, and listen by ear. Feedback here can change the target, roles, or screen, and any fix goes through its own test first.

- [ ] **Step 5: Write `README.md`**

Installing, a run, what Undo does and doesn't cover, known limits (envelopes and devices aren't measured, clips under 3 s are left alone, no Arrangement, transitions still add up), and what has actually been seen in Live, in the style of the repo's README.

- [ ] **Step 6: Commit**

```bash
git add max-for-live/set-leveler
git commit -m "Set Leveler: verify Undo against the saved Set, add README"
```
