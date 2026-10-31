# Set Leveler

A Max for Live device that levels a DJ set's Session clips to one target using clip gain, so one track
moving into another sounds even. The master then only polishes.

> **Status:** unit-tested against a simulated Live. A test device proved in Live 12.4.15 that a generated
> device loads, reads and sets clip gain, and shows its window (`docs/superpowers/notes/set-leveler-spike.md`).
> **The finished device hasn't been run in Live yet.** Test it on a saved copy of a Set first.

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
- Undo only changes gain. If a clip was moved or swapped since, it's skipped and named.
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
