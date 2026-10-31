# Set Leveler

A Max for Live device that levels a DJ set's Session clips to one target using clip gain, so one track
moving into another sounds even. The master then only polishes.

> **Status:** seen working in Live 12.4.15 on a copy of a real DJ set (31 Session clips, 22 tracks, 235 scenes): Analyze, the
> dropdowns and Target box, Apply, Undo and the window. After Undo, a comparison of the saved copy against the original
> showed 0 of 157 clips differing, and Apply changed 30 clips with Arrangement untouched. The owner's transitions passed by
> ear. Progress during Apply and Undo came after that test, so it has only run against a simulated Live.

## Installing

Needs Live 12 Suite, which includes Max. Nothing else to install to run it.

```bash
cd max-for-live/set-leveler
npm install
npm run install-device
```

That copies it to `User Library/Presets/Audio Effects/Max Audio Effect/Set Leveler/`.

## A run

1. Save your Set. Drop **Set Leveler** on any track, then press **Open Set Leveler**. It passes audio through untouched.
2. Press **Analyze**. The first time for a Set, say which tracks hold layers, like Track C.
3. Answer any clips it couldn't place. **See every clip** lets you change any clip's role.
4. Press **Apply**, and listen.
5. Press **Undo** to put it back. Press it again to step back through earlier runs.

Every clip is one of:

- **Its own track:** its loudest stretch moves to the target (-12 LUFS unless you change it).
- **Layered on a track:** it isn't measured, and gets the same change as that track.
- **Leave alone:** it never changes.

**Layer suggestions** come from Arrangement: a layer goes with what it overlaps most there. So they work best
if you worked the set out in Arrangement and those clips are still there. Ties and clips with no match are asked about.

**Weakest link:** if a track would peak more than 2 dB over 0 at the target, the screen names it and says what
matching it costs the set. **Match it** lowers the target by that much. It never does that by itself.

## What Undo covers

- Apply saves every clip's exact gain to disk before changing anything, in
  `~/Library/Application Support/Set Leveler/`. So Undo works after a crash, or after closing and reopening the Set.
- **Moved clips aren't touched.** Undo finds each clip by its track, slot and file. Inserting a scene or a track moves
  clips, so Undo leaves those alone, names them and holds on to their gains. Put them back where they were and press
  Undo again to finish. Earlier runs can't be undone until that one's finished.
- **Save As still works.** If this Set has no run to undo, Undo looks for the newest run from another Set whose clips
  match this one exactly, and says which Set it came from.
- Check what Undo is about to do: the line beside the button says how many clips, when, and from which Set.
- Undo restores the gains on the clips in the open Set. It can't undo anything else you did, and it doesn't save.
- Don't count on Cmd-Z for a whole run.

Check Undo was exact on a test copy: save the copy after Undo, then run

```bash
python3 -I scripts/als-tools.py compare "<original>.als" "<test copy>.als"
```

## Limits

- **Session view only.** Arrangement is only read, for suggestions. 8-track sets aren't covered yet.
- **It measures files.** Clip envelopes and track devices aren't counted, so an EQ or a volume envelope changes
  what you hear but not the reading.
- **Peak is sample peak,** as in stem export. True peak can read over 1 dB higher on hot masters.
- **Clips under 3 seconds get no reading** and are left alone as tracks. Make them layers to move them.
- **Unwarped clips are measured over the whole file,** not just the part they play.
- **Transitions still add up.** Clip gain is static, so two tracks at full level run about 3 dB louder than one.
- **Macs only:** non-WAV files are decoded with macOS `afconvert`.

## Developing

`npm test` runs everything against a simulated Live. `npm run build` writes `dist/Set Leveler/`.
`scripts/build.mjs` generates the device from code, so don't edit the `.amxd` in Max: changes there get overwritten.
