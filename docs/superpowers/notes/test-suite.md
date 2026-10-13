# Test suite, in Live Beta

Temp folder (Export Audio goes here, Cmd-Shift-G in the save sheet):
`/Users/stephenkaplan/conductor/workspaces/ableton-extensions/buffalo/extensions/stem-export/.dev/temp`
Output: `.../stem-export/.dev/storage/out/<song>/`

**Before anything:** Ctrl+C the running `npm start` and start it again (the code changed):
```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
cd /Users/stephenkaplan/conductor/workspaces/ableton-extensions/buffalo/extensions/stem-export && npm start
```
Export settings every time: Rendered Track **Main**, Normalize **off**, WAV, 24-bit, no dither,
Create Analysis File off, and **one Sample Rate for every pass**. Run **Next Pass** after each
export except the last; run **Finish** after the last (the Master reference).
Use a throwaway Set for T1-T7 (5 or 6 tracks, one group, 4-8 bars), set the export range once.

## T1. 44.1 kHz (the change just made)
Export every pass at **44100**. Expect: Next Pass accepts, Finish succeeds, null residual very low.
Check: `afinfo ".../out/<song>/<song> (Drums).wav" | grep "Data format"` says 44100 Hz.
Then a second run: export pass 1 at 44100 and pass 2 at **48000**. Expect Next Pass refuses
pass 2 ("same sample rate"). Re-export it at 44100 and it goes through.

## T2. Your state comes back (the riskiest code, never run in Live)
Before starting: mute one track yourself, solo another, turn a device **on** on Main.
Run a full run. Expect: the start dialog lists the Main device as an info note; during the run
the Main device is off and your solo is cleared; after Finish your mute, your solo and the Main
device are exactly as before.

## T3. Abort halfway
Start a run, do pass 1 and Next Pass, then run **Stem Export: Abort**. Expect: everything from T2
restored, `.dev/storage/runs/` empty, `.dev/temp/collected/` cleaned. Then a fresh run works.

## T4. Groups
Make a group with 3 children; give 2 to a stem, leave 1. Mute a second group that has children.
Expect: the muted group's children read "muted, held out" and are in no stem.
Put **EQ Eight** on the first group and split its children across two stems: the pre-flight warns
"Processed group split across stems", and the null still passes (EQ is linear; about -126 dBFS
measured). The same warning is repeated in the "Stem Export: Pass 1" message, under "Warnings (the
run goes ahead):", and the run starts.
Swap it for **Glue Compressor**: same warning. A Glue Compressor split was measured at -97.9 dBFS,
which passes (the bar is 60 dB under the Master peak), so expect the null to pass and the Finish
dialog to show a "Note" that it passes but not exactly (residual above -110 dBFS, something
nonlinear between the stems and the mix). Information, not a failure. A louder or harder-driven
compressor can still push the residual past the bar and fail the null; that is the limitation the
warning describes, not a bug. A clean Set shows no "Warnings" line and no "Note".

## T5. Same-named tracks
Two tracks with the same name in one group; assign only one. Expect both are separate rows and
the stem contains the right one (listen to it).

## T6. Mapping reloads
Finish a run, then run Stem Export... again with the same Song name. Expect the earlier
assignments are prefilled. Rename one assigned track and reopen: no crash, that track shows as
unassigned (the old assignment cannot be matched), and a note in the dialog says "1 saved
assignment no longer matches a track and was dropped: <old name>". It is not an error and the
dialog still lets you continue. After Continue, the old name is gone from
`.dev/storage/manifests/<song>.json` unless you assigned it again.

## T7. Extras
In the dialog, Extras... add "Kick & Snare" with two tracks. Expect extra passes after the Master
reference, and `out/<song>/Extras/<song> (Kick & Snare).wav`. Extras are not in the null sum.

## T8. A real song you already have stems for
Same mapping you used by hand. Listen to each stem alone and compare with your old one. Null
should pass. If the song has sidechain (your `Bass` ducking from `Kick` is a `Post Mixer` tap) and
the null fails, that is the known limitation: send me the residual and which stems, then change
that tap to Post FX and re-run; the null should now pass.

## T9. Crash recovery (optional, last, throwaway only)
Start a run, do pass 1 and Next Pass, then force-quit Live. Reopen Live and the Set, restart
`npm start`, run **Stem Export: Abort**. Expect your state restored from the saved record. Expect
a "Restore what matches" style dialog, not a crash.

## What to send me
One line per test, pass or fail. For a failure: the `[stem-export]` lines and the text of any dialog.
