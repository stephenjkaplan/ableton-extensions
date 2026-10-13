# Held-list fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the mapping dialog's pre-flight panel update live as the user edits, stop reporting stale saved keys as errors, show warnings when the run starts, and say when the null test passes but is not exact.

**Architecture:** The validator, resolver and planner are already pure TypeScript. They are bundled into the dialog's page so the page runs the SAME code the host runs, not a hand-written copy. The host still re-validates on Continue and remains the authority.

**Tech Stack:** TypeScript, esbuild (already used), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-stem-export-design.md`

## Global Constraints

- **The page must run the real modules, never a re-implementation.** No validation rule is rewritten in `mapping.html`. A rule exists in exactly one place, and the page imports it.
- Pure modules (`snapshot`, `validate`, `plan`, `registry`, `default-registry`, `manifest-core`, `mapping-core`) must import nothing from `node:*`. A test must prove the page bundle builds for `platform: "browser"` with no `node:` reference in the output.
- Filesystem: `storageDirectory` and `tempDirectory` only. No `child_process`. Never touch a `.als`.
- No new dependencies. ESM: relative imports carry `.js`.
- Existing behaviour must not change except where stated. The suite (289 tests at the start) must stay green; update a test only where this plan changes its behaviour, and say so in the report.
- The host re-validates the dialog's reply on Continue. That must remain true.

## Review Focus

1. **Drift between page and host.** The page's findings must equal the host's `check()` for the same Set and mapping. One test must run the bundled page code and the host code on identical input and compare. → Task 3.
2. **A bundle that silently omits a rule or pulls in `node:fs`.** → Task 2.
3. **Payload growth.** The dialog is loaded as a `data:` URL. It is about 46 KB encoded before this change, and the Set structure plus the bundle add roughly 10 KB plus about 0.1 KB per track. A 70-track Set must stay under 120 KB encoded; assert it. → Task 3.
4. **Stale keys dropped silently.** The user must be told, once, in plain words. → Task 4.
5. **A "not exact" note on a clean run.** EQ-only and linear runs read about -126 dBFS and must NOT trigger it. → Task 4.

---

### Task 1: Pure cores

**Files:**
- Create: `extensions/stem-export/src/manifest-core.ts`, `src/mapping-core.ts`
- Modify: `src/manifest.ts`, `src/commands.ts`, `src/snapshot.ts`
- Test: `test/mapping-core.test.ts`, extend `test/snapshot.test.ts`

**Interfaces:**
- `manifest-core.ts` holds everything in `manifest.ts` that does no I/O: the `Manifest`, `StemSpec`, `ExtraSpec`, `Resolution` types, `BACKING`, `emptyManifest`, `safeName`, `resolve`. `manifest.ts` keeps `manifestPath`, `loadManifest`, `saveManifest` and **re-exports everything from `manifest-core.ts`**, so no existing import changes.
- `mapping-core.ts` holds what `commands.ts` has that does no I/O: `assignmentsOf`, `manifestFromResponse`, `check`, and the new `pruneStale`. `commands.ts` imports them and **re-exports** the three that exist today, so existing tests keep working.
- `pruneStale(base: Manifest, snap: SongSnapshot): { manifest: Manifest; dropped: string[] }` removes from every stem and extra any track key that is not in `snap.byKey` or is a group; `dropped` lists each removed key once, in first-seen order. It never removes a key that exists but is muted (that is a held-out track, not stale).
- `snapshot.ts` gains `SnapshotData = { song: string; tracks: TrackSnapshot[]; masterDevices: {name:string; enabled:boolean}[] }`, `snapshotToData(s: SongSnapshot): SnapshotData` and `snapshotFromData(d: SnapshotData): SongSnapshot`. `snapshotFromData` rebuilds `byKey` and `descendantsOf` so the result behaves identically to one built by `snapshotSong`. It must not call `snapshotSong` (that needs live track objects).

**Requirements (tests to write):**
- Round trip: for a Set with nested groups, same-named siblings and a muted group, `snapshotFromData(snapshotToData(s))` gives identical `tracks`, `masterDevices`, `byKey` keys and `descendantsOf` results for every key.
- `snapshotToData` output survives `JSON.parse(JSON.stringify(...))` unchanged.
- `pruneStale`: drops a missing key; drops a group key; keeps a muted-but-present key; prunes extras too; reports each dropped key once; leaves `Backing` computed; does not mutate its input.
- Moving code changed no behaviour: the whole existing suite passes with no test edited except import paths if unavoidable.
- A test imports `validate`, `resolve`, `buildPlan`, `check`, `manifestFromResponse`, `snapshotFromData`, `DEFAULT_REGISTRY` through ONE entry module and bundles it with esbuild `platform: "browser"`; the output contains no `node:`.

### Task 2: Page bundle

**Files:**
- Create: `src/ui/page-core.ts`, `build-page-core.ts` (at the extension root, shared helper)
- Modify: `build.ts`, `vitest.config.ts`, `src/ui/protocol.ts`, `src/ui/mapping.html` (marker only), `src/html.d.ts` if needed
- Test: `test/page-core.test.ts`

**Interfaces:**
- `page-core.ts` is the browser entry. It exposes a single global `StemCore` with: `snapshotFromData`, `manifestFromResponse`, `check`, `pruneStale`. It imports only pure modules.
- `build-page-core.ts` exports `bundlePageCore(): string` returning the minified IIFE source. Used by BOTH `build.ts` and `vitest.config.ts`, so there is one definition of how it is built.
- `protocol.ts`'s `encodeRequest` injects the bundle into the page at a marker (add `<!--CORE-->` inside a `<script>` in `mapping.html`) using a function replacer, exactly as the request is injected, so `$` sequences in the bundle cannot corrupt the page.
- No generated file is committed. `npm run build`, `npm start`, `npm test` and `npm run package` must all work from a clean checkout.

**Requirements (tests to write):**
- `bundlePageCore()` output has no `node:` reference, defines `StemCore`, and is under 25 KB.
- Evaluating the bundle in a `node:vm` context with no globals gives an object whose four functions work (round-trip a small snapshot through `snapshotFromData`, run `check`).
- `encodeRequest` output contains the bundle exactly once and the request exactly once; a bundle containing `$&` and `</script>`-like text would not break the page (test the replacer with a synthetic string, not the real bundle).
- `npm run build` and `npm run package` succeed; report the new `extension.js` size.

### Task 3: Live panel

**Files:**
- Modify: `src/ui/protocol.ts` (`MappingRequest`), `src/ui/mapping.html`, `src/commands.ts` (`requestFor`)
- Test: update `test/mapping-dom.test.ts`, `test/protocol.test.ts`, `test/commands.test.ts`; create `test/page-drift.test.ts`

**Interfaces:**
- `MappingRequest` gains `snapshot: SnapshotData`, `base: Manifest` (the stale-pruned seed manifest) and `taps: KeyTap[]`. The old host-computed `findings` becomes `notes: Finding[]` (host-only information the page cannot compute: the song-name default note, and Task 4's stale-key note). Nothing else about the request changes.
- The page computes its findings on every redraw: build the manifest with `StemCore.manifestFromResponse(REQ.base, {cancelled:false, song, assignments, extras}, song)`, call `StemCore.check(snap, manifest, REQ.taps)`, and show `[...REQ.notes, ...findings]`. The pre-flight header counts update with it.
- The page's own copy of any validation logic is not added. The existing page-side count/preview code (`countStem`, `planned`, the Output panel) stays as it is.
- Host behaviour on Continue is unchanged: re-snapshot, re-check, block on errors.

**Requirements (tests to write):**
- DOM test: with a Set whose group has `EQ Eight` and two children, assigning one child to `Drums` and the other to `Vocals` makes a `Processed group split across stems` warning appear **without closing the dialog**; assigning both to `Drums` removes it.
- DOM test: assigning a stem to a track then clearing it updates the error/warning counts in the header.
- **Drift test (the important one):** for at least five scenarios (clean; split processed group; unknown stem name; a stem whose only track is muted; an extra naming a missing track), run the bundled page code in a `vm` context and the host `check()` on identical input, and assert the findings are deep-equal.
- Payload test: a 70-track Set encodes to under 120 KB.
- Existing DOM, protocol and commands tests pass; update only the ones that read `REQ.findings`, and list them in the report.

### Task 4: Host fixes

**Files:**
- Modify: `src/commands.ts`, `src/run.ts`, `src/audio.ts` (small), `README.md`, `docs/superpowers/notes/test-suite.md`
- Test: extend `test/commands.test.ts`, `test/run.test.ts`, `test/audio.test.ts`

**Requirements:**
1. **Stale keys.** In `configure`, seed the dialog from `pruneStale(base, snap)`. When keys were dropped, add one `info` note to `notes`: `N saved assignment(s) no longer match a track and were dropped: <keys>`. Stale keys must no longer raise `unresolved-ref` errors at dialog open. A key that is dropped must not reappear in the saved manifest unless the user assigns it again.
2. **Warnings at run start.** After a successful re-validation, the "Stem Export: pass 1" message lists every `warn` finding (title and detail) under a "Warnings (the run goes ahead):" line. No warnings: the line is absent.
3. **"Passes, but not exact" note.** `readWav` returns an optional `bits` on `Audio` (16/24/32/64; floats count as 32/64). `finalize` adds `notes: string[]` to its result. When the null test passed AND the residual is above `-110` dBFS AND every render is 24-bit or more, add a note: the stems sum to the mix to within the residual, which is well above the rounding noise of a 24-bit render (about -126 dBFS), so something nonlinear (a compressor, limiter, saturator or sidechain) sits between the stems and the mix. The Finish dialog shows notes. A residual at or below `-110`, a failed null, and a render under 24-bit all produce no such note. The `-110` is a named constant with a comment citing the measured values: linear EQ about -126, Glue Compressor about -98.
4. README and the test suite doc describe all four changes briefly and accurately. They must not claim anything was observed in Live that was not.

**Requirements (tests to write):**
- Stale keys: seed manifest with two stale keys and one valid: the request's `base` has only the valid one, `notes` has the info line naming both, and the findings contain no `unresolved-ref`.
- A run with a split processed group shows the warning in the start message; a clean run does not.
- Null note: residual -126 gives no note; -98 gives the note; a failed null gives no note; a 16-bit render gives no note.
- `readWav` reports `bits` for 16, 24, 32-int and 32-float inputs.

---

### Task 5: Open the dialog on the right song

Added after the user opened a larger project and the dialog prefilled the PREVIOUS test project's name (`T9`) and mapping. Root cause: Live gives extensions no Set name or path (verified in the SDK types), so `configure` prefills the last name typed and seeds the dialog from that name's saved mapping. A different project then shows another song's name and a stale-key note, and typing the right name does not load that song's mapping; Continue then saves the dialog's assignments OVER it.

**Files:**
- Modify: `src/mapping-core.ts`, `src/commands.ts`, `src/ui/message.ts` (only if buttons need extending), `README.md`, `docs/superpowers/notes/test-suite.md`
- Test: extend `test/mapping-core.test.ts`, `test/commands.test.ts`

**Interfaces and behaviour:**
1. `matchManifests(saved: { name: string; manifest: Manifest; mtimeMs: number }[], snap: SongSnapshot): { name: string; manifest: Manifest; matched: number; total: number } | null` in `mapping-core.ts` (pure, no `node:*`). For each saved manifest, `total` is the number of distinct track keys it names across all stems and extras, `matched` is how many of those are in `snap.byKey` and are NOT group tracks. A manifest is eligible when `matched >= 2` AND `matched / total >= 0.6`. Return the eligible one with the highest `matched`; break ties by the most recent `mtimeMs`; return null if none is eligible. It must not mutate its input.
2. In `configure`, list `<storage>/manifests/*.json`, load each (an unreadable or invalid file is skipped, never throws), and call `matchManifests`. If there is a match, seed the dialog from `pruneStale(match.manifest, snap)` and prefill its name, with one `info` note `loaded-saved-mapping`: `Loaded the saved mapping for '<name>': <matched> of its <total> tracks are in this Set.` If there is NO match, seed from `emptyManifest(DEFAULT_SONG)` and prefill `DEFAULT_SONG` ("Untitled Set"), with the existing "set the song name" note. **The last-used name in `song-name.txt` must no longer be used as the prefill.** (It may still be written; it must not be the reason a different project opens with another song's name or mapping.)
3. After the dialog closes, if the confirmed name differs from the name it was seeded with AND a saved manifest exists under the confirmed name, ask once with three buttons: **Load it** (reopen the dialog seeded from that manifest, pruned, with that name prefilled; do not ask again for that name in this `configure`), **Replace it** (carry on and overwrite with what was just set), **Cancel** (change nothing, save nothing). The message states how many tracks the existing mapping names. Do not ask when the confirmed name equals the seeded name, or when no manifest exists under the new name.
4. A failed null test must not tell the user to run Finish again. For a result whose problems include `null-failed`, the Finish dialog's closing line says that running Finish again will not change the result, that the way forward is Abort and re-export, and that the usual cause is a processed group split across stems (the pre-flight warning names it). Other problems keep the current wording.
5. README and `test-suite.md` describe the new opening behaviour and the prompt accurately. Remove any statement that the dialog prefills the last-used name. Do not claim anything was observed in Live that was not.

**Tests to write:**
- `matchManifests`: best overlap wins; below 2 matched or below 60 percent is ineligible; a tie goes to the newer file; group keys and missing keys do not count as matched; another song's manifest with only generic names (`Kick`, `Bass`) that the Set happens to share two of but is under 60 percent is ineligible; input not mutated.
- `configure`: **the reported scenario** - `song-name.txt` says `T9`, a saved `T9` mapping names tracks that are not in the open Set, and the Set matches nothing: the dialog opens with name "Untitled Set", an empty mapping and NO stale-key note and no `T9` anywhere in the request.
- `configure`: a saved mapping that matches the open Set is loaded with its name and the `loaded-saved-mapping` note, even when `song-name.txt` names a different song.
- `configure`: typing a name that has a saved mapping asks; Load it reopens seeded from it (assert the second request's name and assignments); Replace it saves over it; Cancel saves nothing and starts no run. No question when the name is unchanged or new.
- Finish dialog: a `null-failed` result's text no longer says "run Stem Export: Finish again" and does say Abort; a `clipped` problem keeps the old wording.
