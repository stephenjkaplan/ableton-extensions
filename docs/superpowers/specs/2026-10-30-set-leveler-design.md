# Set Leveler — Design

**Date:** 2026-10-30
**Status:** Approved by the owner, narrowed to DJ sets, needed as soon as possible
**Platform:** Max for Live device (named Set Leveler (DJ Set)), Live 12 Suite on macOS
**Mockup:** `docs/superpowers/specs/2026-10-30-set-leveler-mockup.html` (open in a browser)

---

## 1. Intent

Levelling a DJ set is currently done by hand with a meter, clip by clip. Set Leveler sets the gain
on the clips in a Set's Session view in one action, so that one track moving into another sounds
even at performance volume. The master then only polishes. It does not fix levels.

A DJ set clip is either a full track or an extra part or vocal. Mostly two clips play at once, at
most three. Example: `Halloween Party DJ Set.als`, about 30 Session clips on Tracks A, B and C.

**Extras are layers, not tracks.** An extra is layered on something else and doesn't represent a
whole track, so it must not be levelled as one. The catch: Track C is sometimes a third track being
mixed and sometimes a vocal layer, so software can't always tell. The owner clarifies in the dialog.

### Success criteria

- One run gets a whole DJ set close enough to even that the owner only touches up by ear.
- Nothing changes in the Set until the owner presses Apply.
- One button puts back every gain the tool changed, exactly.
- The owner can see which track is holding the set back, and by how much.

## 2. Goals, non-goals, anti-goals

**Goals**
- Level full-track clips in Session view to one target.
- A layer takes the same change as the track it's triggered on.
- Name the weakest link and show what it costs the set.
- Undo that can be trusted while testing on real projects.
- A screen that shows little: what's ready, what needs an answer, what's holding the set back.

**Non-goals**
- **8-track sets and writing to Arrangement, for now.** The owner isn't sure layering fits
  Arrangement. Arrangement is only read, to suggest layer hosts (§4.2).
- No EQ, compression, limiting, or changes to the master chain.
- No automation. Levels live only in clip gain.
- No dynamic handling of transitions. Clip gain is static, so two tracks at full level will still
  add up to about 3 dB louder. The owner handles that when mixing, with `-12` leaving room for it.
- No per-channel level rules, and no reading meaning into a Set's current gains.

**Anti-goals: what would make this a failure even if it works**
- It damages a project, or leaves one in a state that can't be put back.
- It quietly decides things. Suggestions are visible and changeable, and a clip the tool can't
  place stays untouched.
- It buries the owner in numbers. An earlier mockup with loudness and peak columns was "almost too
  much info", and the simplified one was "way better".

## 3. How it gets made

**Owner's decisions**
- Target for a track's loudest stretch: **-12 LUFS** to start. The owner will push the master.
- There must be an undo button.
- A layer moves with the track it's triggered on: if that track goes up 5 dB, so does the layer.
- A dialog lets the owner clarify what the software can't work out. The screen follows the mockup.
- DJ sets only for now.

**Forced by the platform**
- A Max for Live device, not an Extension. The Extensions SDK has no clip gain (`docs/sdk/sdk-api.d.ts`;
  also absent from the host in Live 12.4.15b7). The Live Object Model has read/write `gain` on audio
  clips, along with `file_path`, `warp_markers`, `clip_slots` and `arrangement_clips`.
- Live's Song object documents `undo` but no way to group changes into one undo step. A run could
  leave one history entry per clip, so **Cmd-Z can't be the undo** (see §6).

**Claude's calls, open to change**
- Session view only. The owner earlier wanted either view for DJ sets, then said layering may not
  fit Arrangement, and the set is played from Session.
- Repo: add `max-for-live/set-leveler/` beside `extensions/`. Renaming the repo to `ableton-tools`
  is a separate step, owner's go-ahead required.
- Device internals: `node.script` (Node for Max) does the file reading and analysis, and the Live
  Object Model does the reading and writing of clips. Both ship with the Max bundled in Live.
- Loudness code starts from `extensions/stem-export/src/audio.ts`, adding short-term loudness.
- Non-WAV sources (Halloween uses `.m4a`) are decoded with macOS `afconvert`, so there is no ffmpeg
  dependency for the owner to install.
- UI: `jweb` with an HTML page in its own window is the likely choice, and the builder may change
  this after the spike.
- The role defaults, suggestion rule and weakest-link rule in §4.

## 4. Behaviour

### 4.1 The run

1. Drop the device on any track. It passes audio through untouched.
2. Press **Analyze**.
3. Answer whatever the tool couldn't work out, and optionally look through every clip.
4. Press **Apply**. Press **Undo** to put it back.

### 4.2 What each clip is

Every Session clip has one role:

- **Its own track:** measured and moved to the target.
- **Layered on [track]:** not measured. Takes the exact change of the clip it's on.
- **Leave alone:** never changes.

Starting roles come from Arrangement, on any track, because any of them can hold layers. A clip that sits at least 80% inside
one longer clip is a layer on it. Any other clip in Arrangement is its own track. Hosts are always clips with the "own track"
role, never other layers, and names aren't used: the `A Younger Me` vocal sits over `Shining Star`. If a host stops being a
track, its layers go back to needing an answer. Answers are saved per Set, so they don't have to be repeated.

If there's a tie, the best file is used by more than one Session clip, or the clip isn't in Arrangement, it **needs an answer**
and stays untouched until answered. On Halloween this finds 13 layers across Tracks B and C and asks about 1 clip.

Added after the owner's first test, replacing a question about which tracks hold layers: `Hate It or Love It Samples` is a
layer on Track B, so it was levelled as a track and came out too loud. Hand trims stay flexible: a trimmed layer keeps its
trim and moves with its track.

### 4.3 Measuring

**Loudness** is a clip's *loudest stretch*: the 95th percentile of its short-term LUFS (BS.1770)
over the part of the file it plays, plus its current gain. The part played comes from `loop_start`,
`loop_end` and warp markers. Whole-file average is not used, because a long intro would make a banger
read as quiet. Peak is sample peak over the same part, as in stem export. Clip envelopes and track devices are ignored.

A clip with no reading (missing file, unsupported format, too short) is left alone and listed under
See every clip. Halloween's `Acid Loop` gave no reading in the prototype.

### 4.4 Target and the weakest link

Proposed change = target − clip loudness. The target is a single number, default -12.

A **peak limit, default +2 dB**, decides what counts as too hot. Live doesn't clip internally, so
going over 0 only means the master limiter works on it. The figure comes from measuring Halloween:
at -12, the worst clip got about 2 dB of limiting for about 1% of the time, while at -10 it was
4 dB for about 10%.

The weakest link is the own-track clip whose peak would go furthest over the limit. If one does, the
screen says what matching it costs the set, with a **Match it** button that lowers the target by that
much. The tool never lowers the target by itself. When nothing goes over, the line doesn't appear.

### 4.5 The screen

Follows the mockup, top to bottom:

- **Header:** target.
- **Summary:** "20 tracks and 7 layers ready to level", and the biggest changes.
- **Needs an answer:** only clips that do, each with one dropdown: its own track, leave alone, or
  layered on a track. Unanswered clips stay as they are, so Apply still works.
- **Weakest link:** one line and a button, only when relevant.
- **See every clip:** collapsed by default. Each track with its layers under it: name, role dropdown, change. No loudness or peak columns.
- **Undo** and **Apply**.

A real run also needs Analyze, progress, and Apply and Undo results,
which the mockup leaves out.

## 5. Writing

Only Session clip gain changes. Writes happen only on Apply, then every value is read back and any
mismatch is reported. The device never writes audio files or `.als` files, and never saves the Set.

The Live Object Model's `gain` runs 0.0 to 1.0, not dB. The mapping must be worked out in the spike,
from `gain_display_string`. Reading a clip's current gain in dB needs the same mapping.

## 6. Undo

Undo is the owner's explicit requirement while testing on real projects.

- **Before writing anything**, Apply saves a snapshot to disk: the Set's path, and for each clip
  its track index, slot index, file path and exact raw gain.
- **Undo** restores the raw values from the most recent snapshot. Pressing it again steps back
  through earlier Applies. It then reads back every value and reports the result.
- Snapshots live outside the project, and survive a crash or closing the device, so an interrupted
  Apply can still be restored.
- If a clip no longer matches its snapshot (moved, deleted, different file), Undo skips it and
  lists it, rather than guess.
- Live's own Cmd-Z isn't relied on. If it can undo a run, that's a bonus.

Until the device has earned trust, test on a saved copy of a Set (§7).

## 7. Testing

**First: a throwaway spike.** A tiny device that reads one clip's gain and sets it, built from
generated files and loaded in Live by the owner. It answers the riskiest questions: can Claude
generate a working `.amxd` as text, how does `gain` map to dB, and how many undo entries does a
write create? Its result feeds back into this design.

**Automated:** loudness against known signals, the beats-to-audio mapping, roles and host suggestions
(using Halloween's real layout), the plan, and snapshot save and restore, all against fakes, in the
same style as stem export.

**In Live, by the owner, on a saved copy of the Halloween Set:**
1. Apply, Undo, save the copy, then compare every clip's stored gain against the original `.als`.
   Claude can run this comparison. It should match exactly.
2. Listen to transitions and report back by ear. That's the real test.

## 8. Left to the builder

The file layout inside `max-for-live/set-leveler/`, the Node structure, how the device is packaged
so it works once moved (frozen or not), where snapshots and answers live on disk, and the visual
design beyond the mockup.
