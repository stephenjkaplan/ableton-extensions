# Stem Export Tooling — Design

**Date:** 2026-10-09
**Status:** Design approved, spec under review
**Scope:** Forward-looking only (new songs). Legacy catalog migration explicitly out of scope.

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

### Stems overlap — they are not a partition

`Drums` is the whole drum group; `Kick & Snare` and `Percussion` are **slices of it**.
The data model must allow a source track to belong to more than one stem.

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

stems:
  Drums:          { tracks: [Kick, Snare, Hi-Hat, Crash, Sidechained] }
  Kick & Snare:   { tracks: [Kick, Snare] }          # slice of Drums
  Percussion:     { tracks: [Hi-Hat, Crash] }        # slice of Drums
  Sub37 - Backing:{ tracks: [Pluck Gruv (Sub37 13 15), Sub37 Manual Wub] }
  Arturia - Played:
    tracks: [Syncopated Womp (Jup Sync Lead | Analog Lab V)]
    suffix: " Jup Sync Lead"
  Backing:        { computed: true }                 # everything unclaimed

extras:
  - { name: Plucky Bassline, tracks: [Glidey Bass 14 05] }
```

**Track identity.** Tracks are referenced by name for human readability, but resolved via the
`.als` track `Id` recorded alongside. Names drift; IDs are stable. On load, the tool
reconciles by ID first, falls back to name, and reports anything it cannot resolve rather
than silently dropping it.

**`Backing` is computed**, never enumerated — it is every audio-producing track claimed by no
other stem. This is the structural fix for "I accidentally put a played part in Backing."

**`Extras`** is a folder of arbitrary named sums — any individual track or combination,
independent of the main stem set.

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

**Render count is `N + 1`** — one pass per stem plus the Master reference. For a typical song
that is 8–14 passes, unattended apart from the Export click.

**Overlapping stems cost extra passes.** `Kick & Snare` and `Percussion` are slices of
`Drums`, so they are rendered as their own passes rather than derived. They are included in
the plan but excluded from the null sum (§8).


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

> **Known limit:** overlapping stems (`Drums` ⊇ `Kick & Snare` + `Percussion`) are excluded
> from the null sum, since including them would double-count by construction. The null test
> runs over the non-overlapping cover only.

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
