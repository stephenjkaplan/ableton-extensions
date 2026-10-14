# First-run checklist (dev mode)

Everything here assumes `npm start` is running in a terminal with Node 24 and only Live **Beta** is
open. Replace nothing; the paths are this machine's.

```
Temp folder (point Export Audio here):
  /Users/stephenkaplan/conductor/workspaces/ableton-extensions/buffalo/extensions/stem-export/.dev/temp
Finished stems land in:
  /Users/stephenkaplan/conductor/workspaces/ableton-extensions/buffalo/extensions/stem-export/.dev/storage/out/<song>/
```

`.dev` is a hidden folder. In any macOS file sheet, press **Cmd-Shift-G**, paste the path, press Return.

## Use a throwaway Set first

1. New Set, at whatever sample rate you normally use (44.1 or 48 kHz both work).
2. 5 or 6 tracks that make sound across the whole arrangement, 4 to 8 bars, one of them in a
   group. Leave the Main track's devices as they are.
3. Select the whole arrangement range **once**. Do not change it again for the rest of the run.

## The run

4. Right-click a track > **Stem Export...** Type a **Song** name. Give 2 tracks to `Drums`; leave
   the rest alone (they fall into Backing). Check the Output panel lists the files you expect,
   then **Continue**.
5. **Checkpoint:** a message names the temp folder and the output folder, and every track except
   the first pass's is muted. `.dev/storage` should now contain `manifests/` and `runs/`. If it
   is still empty, you are not running this checkout's host: stop and tell me.
6. **File > Export Audio/Video** (Cmd-Shift-R), with these settings (from my memory of Live's
   dialog, so names may differ slightly):
   - Rendered Track: **Main**
   - **Normalize: off** (it would change each pass's level and break the null test)
   - Convert to Mono: off. Render as Loop: off. Create Analysis File: off
   - File Type: **WAV**. Sample Rate: your Set's rate, the **same for every pass**. Bit Depth: 24. Dither: none
   - Folder: the temp folder above. File name: anything.
7. Wait for the export to finish. Then right-click a track > **Stem Export: Next Pass.** It claims
   the file, mutes for the next pass, and says which pass is next.
8. Repeat 6 and 7. The last pass is **Master reference** (everything unmuted). After exporting it,
   run **Stem Export: Finish**, not Next Pass.
9. **Finish** restores your mutes and Master devices, writes the files, and shows the output
   folder and the **null residual**. With 2 assignments you export 3 times: Drums, Backing, Master.

## What good looks like

- Output has `<song> (Drums).wav`, `<song> (Backing).wav`, `<song> (MASTER REFERENCE).wav`.
  The Master reference is not a stem.
- The null residual is far below the reference's own level (the dialog says how far).
- Your original mutes, solos and Main devices are back exactly as you left them.
- The terminal shows `[stem-export] ...` lines. The same `pid` across commands, with a rising
  invocation number, means the host stays running between commands.

## If anything goes wrong

Run **Stem Export: Abort**. It puts the Set back exactly as found. Then send me the `[stem-export]`
lines and the text of any dialog.
