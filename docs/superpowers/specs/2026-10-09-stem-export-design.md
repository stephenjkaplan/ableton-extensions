# Stem Export Tooling — Design

**Date:** 2026-10-09
**Status:** Design approved, spec under review
**Scope:** Forward-looking only (new songs). Legacy catalog migration explicitly out of scope.
**Platform:** Ableton Extension (Extensions SDK, Live 12.4.5+ Suite). Revised 2026-10-09 — see §12.

---

## 1. Intent

Finishing a song currently ends with a manual, memory-dependent stem export: solo exactly
the right tracks, render, repeat ~12 times. Nothing records what belonged to which stem, so
the mapping exists only in the author's head at the moment of soloing.

Stems serve two use cases:

1. **Edits / flips / remixes** — stems get reassembled in a new project.
2. **The live set** — stems load into fixed slots per deck; `Played` variants are muted when
   the part is performed live, `Backing` variants when it isn't.

### Success criteria

- The mapping from source track to stem is **recorded**, auditable, and revisable.
- `Backing` is never hand-tracked — it is **computed** as everything no other stem claims.
- Changing what is played live is a one-row edit, not an act of recall.
- Export is automated around a single manual trigger per stem.
- Stem levels are **consistent across songs** so they sit together in the live set.
- Stem names always land in a live set slot.

### Non-goals

- **No constraint on the creative process.** The tool never dictates how projects are
  organized, grouped, or mixed.
- **The tool never writes a `.als`.** Read-only, always.
- No stem-aligned project template, no bus layer, no regrouping transformer, no moving
  devices. (All were explored and rejected — see §9.)
- No legacy catalog migration.
- No mastering. Set-level level-mastering is a **separate future tool** (§10).

---

## 2. Evidence base

Findings from inspecting the actual library. These drive the design; recorded so later
decisions can be traced.

### Live set structure

`Live Set (Columbus - Arturia).als` (Live 12.4.3) is the structural template: two mirrored
decks, each a fixed set of slots.

```
Drums A              → Drums · Kick & Snare · Percussion
Instruments A        → 8 instrument subgroups, each Played / Backing
                       (Sub37 uniquely: Played ONLY SUB / Played Rev2-able / Backing)
Sample A · Backing A
```

**Slots are relabelable, not a fixed vocabulary.** Two live sets in the same folder disagree:
`Columbus` has `Vocals` in instrument slot 8 where `Mission` has `Talkbox`; `Mission`'s deck B
splits `Keys`/`Arturia` into `Keys 1`/`Keys 2`. So the live set provides a fixed *count*
(8 instrument slots per deck) that gets renamed per show.

### Stem vocabulary (songs per stem name, 48 folders)

```
Backing  38 │ Drums 37 │ Kick & Snare 29 │ Guitar-Played 26 │ Percussion 23
Guitar-Backing 21 │ Sub37-Played 18 │ Rev2-Played 18 │ Sub37-Backing 16
Vocals 14 │ Rev2-Backing 12 │ Organ-Backing 11 │ Organ-Played 9
Rhodes-Played 8 │ Rhodes-Backing 8 │ Serum-Backing 7 │ Clavinet-Played 6
Serum-Played 5 │ Sub37-Rev2 Playable 4 │ Pianet-Backing 3 │ Talkbox 2 │ Keys 2 │ Arturia 2
```

`Rhodes` (8) and `Clavinet` (6) are **more common than** `Keys` (2) or `Arturia` (2).
Collapsing them into `Keys` would fold frequent stems into a rare slot name — so the
vocabulary is a **registry that grows**, not a fixed list.

Observed naming drift to be caught by validation: `Organ - Playedl`, `Sub37- Played`,
`Surrounded by Love` vs `Surrounded By Love`, `Organ - Flex`, `Soft Synths - Played`.

### Stems partition; overlaps are Extras

`Drums` is the whole drum group. `Kick & Snare` and `Percussion` overlap it, and they are
**not required to compose the mix** — they are insurance cuts. So they are **Extras**, not
stems (decided 2026-10-09).

This makes the main stem set a **strict partition**: every audible track belongs to exactly
one stem. Three properties follow for free:

- `Backing` is exactly the unclaimed remainder — no ambiguity.
- The null test (§8) is exact over the *complete* stem set, with no carve-out.
- A track's assignment is a single value, not a set — simpler model and simpler UI.

**Extras** are arbitrary named sums layered on top: any track or combination, overlapping
freely, rendered into `Extras/`. `Kick & Snare`, `Percussion`, `Plucky Bassline`, `Viola`
are all the same kind of thing.

### Source projects: groups cross stems

`Learning to Feel.als` (~75 tracks) groups by *role* — `Drums`, `Bass`,
`Arps, Plucks & 16th Notes`, `Sound Design`, `Samples`, `Keys`, `Horns`, `FX` — while stems
are organized by *instrument*. The partitions cross: `Pluck Gruv (Sub37 13 15)` sits in
`Arps` but belongs to the Sub37 stem; `Sub37 Manual Wub` sits in `Sound Design` but also
belongs to Sub37.

Group tracks carry essential processing:

| Group | Devices |
|---|---|
| `Drums` | rack, 2 plugins |
| `Sidechained` | 2× GMaudio Ducker, 2 plugins |
| `Bass` | 2× GMaudio Ducker |
| `Arps, Plucks & 16th Notes` | GlueCompressor |
| `Sound Design` | 2× GMaudio Ducker, gain, 2 plugins |
| `Samples`, `Percy Mayfield Chops`, `I Feel a Change`, `FX` | various |
| `A-Reverb` / `B-Reverb` returns | both in use |

**Consequence:** per-track renders bypass group processing
([Live 12 manual](https://www.ableton.com/en/manual/managing-files-and-sets/):
"the post-fader signal at the output of each individual track"). Offline summing of
individual-track renders would strip ducking and glue. **Solo-in-place + render Master is
the only method that preserves everything** — which is the existing workflow.

### Sidechain tap points — the decisive finding

All audio sidechain taps in `Learning to Feel`:

```
 4×  Snare  → Pre FX        pre-mixer  ✅
 4×  Kick   → Pre FX        pre-mixer  ✅
 3×  Hi-Hat → Post FX       pre-mixer  ✅
 3×  Kick   → Post FX       pre-mixer  ✅
 3×  Snare  → Post FX       pre-mixer  ✅
 1×  Slynk  → Post FX       pre-mixer  ✅
 1×  Kick   → Post Mixer    post-mixer ❌
```

18 of 19 tap **before** the mixer, so fader and mute do not affect the key signal and
ducking survives exclusion. Exactly one `Post Mixer` tap breaks when its key source is
excluded. This reduces a feared design-breaker to a **validation rule**.

> **Open verification (V1):** confirm empirically that a `-inf` fader (and mute) does not
> silence `Pre FX` / `Post FX` sidechain taps. Reasoned from signal flow and consistent with
> documented behavior, but not yet measured. The design depends on it.

### Master chains

Historically inconsistent — present in older projects (Ozone 5/9, soothe2, Audio Effect Rack
+ SpectrumAnalyzer), absent in most recent ones. Mastering happens **outside Live**: the
`MASTERING` projects contain only a `Premaster` audio track with no devices. The live set's
Master is also empty.

**Forward pattern (adopted):** export with all Master devices bypassed. Every stem is
premaster. One stem set serves both use cases — no master-chain variants, ever.

### Level inconsistency — the real remaining problem

Premaster levels vary widely between songs; the `-6`/`-8 dBFS` convention is recent and still
requires a corrective Utility before the mastering devices. This is what makes stems fail to
sit together in the live set, and §7 addresses it.

---

## 3. Architecture

```
┌─────────────────┐     reads (never writes)
│  Song .als      │ ──────────────────────────┐
└─────────────────┘                           │
                                              ▼
┌─────────────────┐                  ┌──────────────────┐
│  registry.yaml  │ ───────────────▶ │   Core engine    │
│  (this repo)    │                  │  reader·validator│
└─────────────────┘                  │  planner·levels  │
                                     └──────────────────┘
┌─────────────────┐                     ▲    │      │
│  stems.yaml     │ ◀───────────────────┘    │      │
│  (beside .als)  │                          │      │
└─────────────────┘                          ▼      ▼
                                   ┌───────────┐  ┌──────────────┐
                                   │ Mapping UI│  │Post-processor│
                                   │ local web │  │name·file·null│
                                   └───────────┘  └──────────────┘
                                          │
                                          ▼
                                   ┌──────────────┐   sets mute/fader
                                   │ Live bridge  │ ─────────────────▶ Live
                                   │ remote script│   bypasses master
                                   └──────────────┘   restores after
```

Each unit is independently testable. The core engine has no dependency on Live running —
it operates on `.als` files and audio files, which makes the bulk of the system testable
offline.

### Components

| Component | Responsibility | Depends on |
|---|---|---|
| **Reader** | Parse `.als` (gzipped XML) → track tree, group topology, device chains, sidechain taps, master device states | nothing |
| **Registry** | Instrument vocabulary + live set slot template | nothing |
| **Manifest** | Per-song track→stem assignment, persisted beside the `.als` | nothing |
| **Validator** | All rules in §6 | Reader, Registry, Manifest |
| **Planner** | Compute per-stem exclusion sets; order the render passes | Reader, Manifest |
| **Live bridge** | Apply exclusion state; bypass/restore Master devices | Planner |
| **Post-processor** | Rename, file, normalize, null-test, report | Manifest, Registry |

---

## 4. Data model

### Registry (`registry.yaml`, in this repo)

Seeded from `Live Set (Columbus - Arturia)`, grows as gear changes.

```yaml
instruments:
  - { name: Guitar,       variants: [Played, Backing] }
  - { name: Sub37,        variants: [Played ONLY SUB, Played Rev2-able, Backing] }
  - { name: Prophet Rev2, aliases: [Rev2], variants: [Played, Backing] }
  - { name: Organ,        variants: [Played, Backing] }
  - { name: Rhodes,       variants: [Played, Backing] }
  - { name: Clavinet,     variants: [Played, Backing] }
  - { name: Keys,         variants: [Played, Backing] }
  - { name: Arturia,      variants: [Played, Backing] }
  - { name: Serum,        variants: [Played, Backing] }
  - { name: Vocals,       variants: [Played, Backing] }
  # … Pianet, Talkbox, Piano, Vibes, Drum Pad

fixed_stems: [Drums, Kick & Snare, Percussion, Samples, Vocal Samples, Backing]

live_set:
  instrument_slots_per_deck: 8
  decks: 2

naming:
  pattern: "{song} ({stem}){suffix}"     # suffix e.g. " Jup Sync Lead"
  stems_root: "…/Live Sets (8-track)/Content/Stems"
```

### Manifest (`stems.yaml`, beside the `.als`)

```yaml
song: Learning to Feel
als: Learning to Feel.als
level:
  target_lufs: -18          # calibrate on first real songs
  true_peak_ceiling_db: -6
  applied_gain_db: null     # written at export

# Exactly one stem per audible track — a strict partition.
stems:
  Drums:          { tracks: [Kick, Snare, Hi-Hat, Crash, Cam Drums, Fills, …] }
  Sub37 - Backing:{ tracks: [Pluck Gruv (Sub37 13 15), Sub37 Manual Wub] }
  Arturia - Played:
    tracks: [Syncopated Womp (Jup Sync Lead | Analog Lab V)]
    suffix: " Jup Sync Lead"       # → "… (Arturia - Played) Jup Sync Lead.wav"
  Backing:        { computed: true }                 # everything unclaimed

# Arbitrary named sums → Extras/. Overlap stems and each other freely.
extras:
  - { name: Kick & Snare,    tracks: [Kick, Snare] }
  - { name: Percussion,      tracks: [Hi-Hat, Crash] }
  - { name: Plucky Bassline, tracks: [Glidey Bass 14 05] }
```

**Track identity.** Tracks are referenced by name for human readability, but resolved via the
`.als` track `Id` recorded alongside. Names drift; IDs are stable. On load, the tool
reconciles by ID first, falls back to name, and reports anything it cannot resolve rather
than silently dropping it.

**`Backing` is computed**, never enumerated — it is every audio-producing track claimed by no
other stem. Because stems partition, this is exact. This is the structural fix for
"I accidentally put a played part in Backing."

**`Extras`** is a folder of arbitrary named sums — any individual track or combination,
independent of the main stem set and free to overlap it.

### Output destination

Resolved from the registry and shown in the UI *before* export, never implied:

```
<stems_root>/<song>/<song> (<stem>)<suffix>.wav
<stems_root>/<song>/Extras/<song> (<extra>).wav
```

The mapping screen displays the absolute destination folder and the exact filename each
stem will produce, so filing is verifiable up front rather than discovered afterward.

---

## 5. Export workflow

**Exclusion, not soloing.** For each stem, every track *not* belonging to that stem is
excluded by setting its mixer fader to `-inf`, then the Master is rendered. Fader and mute
are both post-mixer, so `Pre FX` / `Post FX` sidechain taps continue to feed their duckers —
which is why ducking survives (§2). Soloing would work equally well in principle; fader
exclusion is chosen because it is a single uniform mechanism with no solo/mute interaction
to reason about.

**Pre-existing mute states are preserved.** A track the author deliberately muted stays
silent in every stem. The tool records the original mixer state of every track before the
run and restores it afterward, so the project is left exactly as found.

Per song, the run is:

```
1.  Read .als → track tree, groups, sidechain taps, Master device states
2.  Load stems.yaml (or build it in the mapping UI)
3.  Validate (§6) — block on errors
4.  Bridge: snapshot all mixer + Master device states
5.  Bridge: bypass every Master device                    ← enforces premaster
6.  For each stem in the plan:
        bridge sets fader -inf on all non-member tracks
        author hits Export (Master)                       ← the one manual step
        tool collects the rendered file
7.  Render the Master once with nothing excluded           ← reference for §8
8.  Bridge: restore every mixer + Master device state
9.  Normalize (§7), name, file, null-test (§8), report
```

**Render count is `N + 1 + E`** — one pass per stem, the Master reference, then one per
extra. `Learning to Feel` works out to 11 + 1 + 4 = 16, unattended apart from the Export
click.

**Extras cost extra passes.** Each extra is its own render pass, appended after the stems
and the Master reference. They sit outside the null sum (§8) by definition, since they
overlap.


## 6. Validation rules

Run before any export; export is blocked on errors, warned on the rest.

| Rule | Severity | Rationale |
|---|---|---|
| Unassigned tracks listed explicitly | **info** | They land in `Backing` — shown so it's a decision, not an accident |
| A stem would render silent | **error** | Catches a mis-assignment before 12 render passes |
| Stem name not in registry | **error** | Catches `Organ - Playedl`, `Sub37- Played` |
| Song name inconsistent with existing folder | **warn** | Catches `Surrounded by` vs `Surrounded By` |
| Sidechain tap is `Post Mixer` and its key source is excluded from a stem | **error** | Ducking would be missing from that stem |
| A processed group is split across stems | **warn** | Names the group and devices; author decides |
| Any Master device enabled | **error** | Enforces the premaster pattern |
| A track belongs to no stem *and* is muted in the project | **info** | Intentionally disabled ideas stay out |
| Song needs more instrument slots than a deck has (8) | **warn** | Won't load cleanly into the live set |

---

## 7. Level normalization

**One gain per song, applied uniformly to every stem of that song.**

This preserves relative balance exactly: the sum of normalized stems equals the premaster mix
scaled by a single constant. Additivity is structural, not approximate.

Procedure:

1. Sum the rendered stems → this *is* the premaster mix (and is already computed for §8).
2. Measure integrated loudness (EBU R128) on that sum.
3. Compute the gain to reach `target_lufs`.
4. Clamp the gain so the loudest stem's true peak stays under `true_peak_ceiling_db` (-6 dBFS).
5. Apply the gain to every stem in float; write 24-bit.
6. Record `applied_gain_db` in the manifest.

**Headroom is deliberate.** The live set sums up to ~19 stems per deck across two crossfading
decks. The target must leave room for a full crossfade without clipping — hence a target well
below release level, with the `-6 dBFS` true-peak ceiling preserving the existing convention
as a hard limit.

**Reversible without re-exporting.** Because the applied gain is recorded, changing the target
later is a gain multiply over existing files — seconds, no Live, no re-render.

> **Open calibration (V2):** `target_lufs: -18` is a starting value. Calibrate against a few
> real songs and the live set's actual summing headroom before treating it as settled.

---

## 8. Verification — the null test

After export, the tool renders the Master once and checks:

```
residual = Σ(stems) / applied_gain  −  master_render
```

If the residual is below −60 dBFS, the stem set provably accounts for the entire mix with
nothing missing and nothing double-counted. The report states, per song, which stems are
exact and which carry a caveat from §6.

This is the load-bearing safety property of the whole design: correctness is **measured**,
not asserted.

Because stems partition (§2), the null test covers the **complete** stem set with no
carve-out. Extras are excluded by definition — they overlap, so including them would
double-count.

---

## 9. Rejected approaches

Recorded so they are not revisited without new information.

| Approach | Why rejected |
|---|---|
| **Stem bus layer in the song project** — route each source track to a stem bus | Rerouting takes tracks out of their musical group, stripping group processing (ducking, glue). Would produce audibly wrong stems. |
| **Generated stems project** — tool writes a derived `.als` with buses | Same signal-path problem, plus plugin reload cost and corruption risk. |
| **Offline summing of per-track renders** — one export pass, assemble stems as arithmetic | Elegant and nearly adopted, but per-track renders bypass group processing. Sidechain ducking lives on group tracks (`Sidechained`, `Bass`, `Sound Design`), so Sub37 stems would lose their ducking. Preserving sidechain is non-negotiable. |
| **Stem-aligned project template** — organize groups to match stems from the start | Imposes structure on the creative process. Rejected outright: full creative freedom before the export step is a hard requirement. |
| **Regrouping transformer** — tool reorganizes a copy, moving devices by linearity analysis | Technically viable (duckers are externally-keyed time-varying gains, hence linear and splittable), but a large build with real correctness risk, and it exists only to save export passes. Export passes are time, and time can be unattended. |
| **Per-song master chains in the live set** | Too heavy to switch per song mid-set. |
| **Mastered backing mix + played stems only** | Loses the per-element control needed for in-place ad-hoc edits in live set timelines. |
| **UI automation of the Export dialog** | Brittle against Live updates; automates a step that is already one click. |

---

## 10. Future work

- **Set-level level-master tool** — automate the manual level pass over a built live set.
  Separate tool in the same suite; operates on the live set, not on stems.
- **Legacy catalog migration** — build manifests for the 48 existing stem folders by reading
  their projects and existing stem filenames.
- **Auto-suggested assignments** — infer stem from track name. Deliberately deferred; the
  mapping table is the product, guessing is a convenience.
- **One-pass export** — revisit only if export time becomes the actual bottleneck.

---

## 11. Open questions

| # | Question | Blocks |
|---|---|---|
| V1 | Does a `-inf` fader (or mute) silence `Pre FX` / `Post FX` sidechain taps? | Correctness of every stem whose key source is excluded |
| V2 | What `target_lufs` actually sits right across songs and leaves crossfade headroom? | Level consistency; calibration only, not architecture |
| V3 | Remote script choice: AbletonOSC vs. a minimal custom script | Bridge implementation |
| V4 | Does `Include Return and Main Effects` need to be on, given Master devices are bypassed? | Whether return reverb reaches the stems correctly |


---

## 12. Platform revision — Ableton Extensions SDK

**Superseded:** the offline Python core and the separate Live bridge. Live 12.4.5 ships an
official [Extensions SDK](https://www.ableton.com/en/live/extensions/), and this is built as
an Extension instead.

### What changes

| Was | Now |
|---|---|
| Python package + CLI | TypeScript Extension, packaged `.ablx` |
| Parse the `.als` offline | Read the **open Live Set** through the API |
| Remote script bridge (deferred) | Built in — same process |
| Local web app for the UI | `context.ui.showModalDialog()` inside Live |
| Fader to `-inf` for exclusion | `track.mute` — also post-mixer, so pre-mixer taps still feed duckers (§2) |

**The `.als` parser is deleted entirely.** The API exposes everything the reader provided:
`song.tracks`, `track.groupTrack` (hierarchy), `track.devices`, `track.name`, `track.mute`,
`track.solo`, `track.mixerDevice`, `song.mainTrack`, `song.returnTracks`. Reading the live
set is both simpler and more accurate than parsing the file — and the corruption risk that
worried us is gone, because no `.als` is ever opened.

The cost: the tool only works on the **currently open set**. That was already true in
practice, and legacy migration is out of scope.

### Verified platform facts

Confirmed from a real extension's source, a real `manifest.json`, and symbol inspection of
`ExtensionHostNodeModule.node` in the installed beta:

- **Runtime is Node.js `>=24.16.0` but under a permission model** — see §13. This is the
  single most consequential constraint and it was initially read wrong.
- **Entry point** is `export async function activate(activation)` → `initialize(activation, "1.0.0")`.
- **Invoked** via `context.ui.registerContextMenuAction(scope, title, commandId)` plus
  `context.commands.registerCommand(id, cb)`.
- **Mutations** are wrapped in `context.withinTransaction(() => …)`; properties are plain
  JS accessors (`track.name = "x"`), not method calls.
- **UI** is `await context.ui.showModalDialog(url, width, height)`, which accepts a
  `data:text/html,…` URL and returns a string the dialog posts back. The mockup in
  `.context/mockup/index.html` becomes the real UI essentially as-is.
- **Progress** is `context.ui.withinProgressDialog(text, opts, async (update, abort) => …)`.
- **Master bypass** is achievable: `song.mainTrack` → `devices` → `parameters` → set the
  "Device On" parameter (`deviceParameterSetInternalValue` in the native layer).
- **Storage** — `context.environment.storageDirectory` (per-extension) holds the registry;
  the manifest still sits beside the `.als` via `node:fs`, per §4.
- **The extension is resident, not one-shot.** `activate` is called by the host when the
  extension is *loaded*, where it registers commands; the process then stays alive to serve
  them. Module-scope state survives between commands, and a watcher started in one command
  keeps firing. (An earlier reading of a community doc said one-shot. It is wrong.)
- **There is no general render API.** The only render entry point is `renderPreFxAudio`,
  which renders a take lane's *pre-FX* audio for the sample-swap feature. So §5 is unchanged:
  the author still triggers Export Audio by hand, once per pass.

### Version requirement — important

Extensions need the **Live 12 Beta**, not the current stable release:

```
/Applications/Ableton Live 12 Suite.app   12.4.6       → no Contents/Helpers/ExtensionHost
/Applications/Ableton Live 12 Beta.app    12.4.15b6    → ExtensionHostNodeModule.node present
```

So the README must say: run from the Beta until Extensions reach stable.

### Project layout

```
extensions/stem-export/
  manifest.json        { name, author, entry, version, minimumApiVersion }
  package.json         type: module, engines.node >=24.16.0
  build.ts             esbuild bundle → dist/extension.js
  vendor/              @ableton-extensions/{sdk,cli} tarballs (not on npm)
  src/
    extension.ts       activate(), command + context-menu registration
    model.ts           Track/Project snapshot read from the API
    registry.ts        instrument vocabulary (§4)
    manifest.ts        stems.yaml beside the .als (§4)
    validate.ts        the rules in §6
    plan.ts            per-pass exclusion sets (§5)
    audio.ts           loudness, gain, null test (§7, §8)
    postprocess.ts     naming, filing, verification (§4)
    ui/                the modal dialog HTML
```

### Open dependency

`@ableton-extensions/sdk` and `@ableton-extensions/cli` are **vendored tarballs from the beta
download**, not published to npm. They are required before any code can be written against
real types. Everything above is verified behaviour, but exact signatures need the shipped
`.d.ts`.


---

## 13. Filesystem permission model — architecture consequence

The SDK docs are explicit, and this invalidates two earlier assumptions:

> Extensions run under a permission model that restricts which parts of the filesystem they
> can access. Your extension can read and write to: **Storage directory**
> (`context.environment.storageDirectory`) … **Temp directory**
> (`context.environment.tempDirectory`).
>
> Your extension **should not** access arbitrary paths like the user's Documents, Downloads,
> or Desktop folders. … A stricter OS-level sandbox will be introduced in the future. … If
> your extension accesses paths outside the allowed set today, it will break when stricter
> sandboxing is enforced.
>
> **Do not work around the permission model.** … This includes child processes spawned via
> `child_process` and code running in native addons.

### What this breaks

| Spec said | Status |
|---|---|
| §4 — manifest lives beside the `.als` | **Not permitted.** `~/Documents/Ableton/…` is outside the allowed set. |
| §4 — stems filed into `Content/Stems/<song>/` | **Not permitted from the extension.** |
| §12 — `child_process` as an escape hatch | **Explicitly forbidden.** |

### Revised architecture: two pieces, one shared core

The split follows the permission boundary exactly.

```
extensions/stem-export/     ← Ableton Extension. Knows Live, limited disk.
    snapshot · mapping UI · validate · plan · apply mutes
    master bypass · pass advance
    writes manifest + plan JSON to storageDirectory

tools/stem-finish/          ← Companion CLI. Normal Node process, no restrictions.
    reads manifest + plan from storageDirectory
    ingests renders · renames · files into Content/Stems
    levels (one gain per song) · null test
    optionally copies the manifest beside the .als for archival

packages/core/              ← Shared, pure, no I/O
    registry · manifest schema · validate · plan · audio math
```

The CLI is **run by the author**, never spawned by the extension — spawning would inherit the
restriction and violate the rule.

### Manifest location — revised from §4

`storageDirectory`, keyed by song name, written by the extension. The CLI may additionally
copy it beside the `.als`, because the CLI is unrestricted. The "travels with the project"
property is preserved, just produced by the other half of the system.

### Render destination decides the loop

The extension may read `tempDirectory`. So:

- **If renders go to `tempDirectory`** — the extension can watch that folder and advance
  passes automatically. One right-click for the whole song. The author sets Live's export
  destination once; Live remembers it.
- **If renders go anywhere else** — the extension cannot see them, so passes advance by a
  manual `Next Pass` command, and the CLI ingests the files afterwards.

Both share all logic and differ only in the advance trigger.
