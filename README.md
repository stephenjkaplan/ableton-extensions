# Stem Export

An Ableton Live Extension that turns a finished track into a folder of correctly named, levelled,
null-tested premaster stems, ready to drop into a live-performance library.

It lives in `extensions/stem-export/`. It does the tedious parts (muting the right tracks for each
pass, bypassing the Master, naming files, levelling, checking the sum) and leaves the actual
rendering to Live's own Export Audio/Video.

> **Status: written and unit-tested, never run in Live.** The logic is covered by tests against
> fakes. The real Live integration is not: `src/live.ts` (the only module that talks to the SDK),
> the actual webview, its `close_and_send` reply and the dialog sizes have never been run against a
> real Live Set.
>
> **Read before trusting it with a song:** the SDK cannot see sidechain routing, so a **Post Mixer**
> sidechain (your `Bass` group ducking from `Kick`) can lose its ducking in a pass with no warning.
> See [Limitations](#3-limitations-read-these).

---

## 1. Installing into Ableton

### What you need

- **Live 12 Suite Beta 12.4.15b6 or later.** Extensions only exist in the Live 12 beta.
  The stable release (12.4.6 at the time of writing) has no `Contents/Helpers/ExtensionHost`
  and **will not run this extension**.
- **A 48 kHz Set and 48 kHz exports.** The loudness measurement only works at 48 kHz; any other
  sample rate is rejected when you run Next Pass. Set Live's export sample rate to 48000.
- **Node 24.16 or later**, for the SDK's command-line tools (`node -v` to check). Building and
  `npm start` need it. Whether installing an already-built `.ablx` needs Node at all has not been checked.

### Joining the beta

Join the Live beta program from your Ableton account, install "Live 12 Suite Beta" alongside
your stable Live, and update it to 12.4.15b6 or later. The Extensions SDK ships with that beta
download; the two tarballs this project needs are already vendored in
`extensions/stem-export/vendor/`.

### Where the `.ablx` comes from

You build it. There is no published download.

```bash
cd extensions/stem-export
npm install
npm test            # optional
npm run package     # builds for production and writes stem-export-1.0.0.ablx
```

The archive is `extensions/stem-export/stem-export-1.0.0.ablx`.

### Installing it

In Live Beta: **Settings > Extensions**, then either drag the `.ablx` onto that pane or use
**Install Extension**. The commands then appear when you right-click an audio or MIDI track.

> The menu names and gestures in this section (and the export-dialog steps below) come from the
> SDK documentation and the build tooling's output. **None of it has been observed in Live**, so
> expect to adjust a step or two.

### Developing

1. In Live Beta, **Settings > Extensions**, switch on **Developer Mode**.
2. Put the path to the Beta's Extension Host module in `extensions/stem-export/.env`. On a stock
   install it is (spaces and all, no quotes needed in a `.env` line; quote it if you export it in
   a shell):

   ```
   EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node
   ```

   (`.env` is gitignored; each machine sets its own. This file was found at that path on the
   machine this was built on.)
3. `npm start` builds a dev bundle and launches it in the Extension Host. Leave it running; log
   output is expected to appear in that terminal (unconfirmed).

   Needs Node 24.16 or later on your PATH, and **only the Beta open**. With stable Live open as
   well, the host timed out with "Failed to connect to Live within 10s" (the cause was not
   isolated, so treat that as a suspicion, not a finding).

   In this mode the CLI, not Live, starts the host, and it only hands the extension a storage and
   temp folder if you give it one. `npm start` passes `extensions/stem-export/.dev/storage` and
   `.dev/temp` (gitignored, created for you). Without them the extension refuses to run with
   "no storage or temp directory". The folder you point Live's Export Audio at (step 5 below) is
   therefore `.dev/temp` while developing, and an installed `.ablx` gets whatever folder Live
   chooses.

---

## 2. The process

The shape of a session, start to finish. The tool's own dialogs explain their buttons.

1. **Finish the track.** Stems are a snapshot of a finished arrangement. Leave your Main track
   devices as they are: the tool reads which are on, bypasses them for the run, and puts them back
   (the dialog lists them as an info note). You never have to remember.
2. **Run Stem Export...** (right-click any audio or MIDI track). The dialog opens with a **Song**
   field at the top. Live does not expose the Set's name to extensions, so type it; it names every
   output file, the saved mapping and the output folder, and the last name you used is prefilled.
   Check it every time. A stale name silently shares a saved mapping and overwrites that song's
   earlier output folder. The dialog lists every track.
3. Decide what you will **play live** and give each of those tracks to a named stem (Drums,
   `Rhodes - Played`, ...). Everything that is meant to run as **backing** you leave alone.
4. **Let `Backing` collect the remainder.** You never assign Backing. Any audible track you did
   not claim falls into it, and the dialog shows what that is. Tracks you have muted are held
   out of every stem; the dialog says so. A pre-flight panel flags problems, and the host
   re-checks the mapping when you accept: errors block the run, whatever the dialog showed.
5. **Set Live's export destination once**, to the temp folder the dialog shows (it has a Copy
   path button). Live is expected to remember it afterwards (unverified). The folder is hidden
   from the Finder, so in the macOS save sheet press **Cmd-Shift-G**, paste the path and press
   Return.
6. **Export once per pass.** The tool has muted everything except the first pass's tracks. Use
   File > Export Audio/Video (render the Main track, any file name). **Export WAV only
   (AIFF cannot be read), one file per pass, and put nothing else in that folder**: the tool treats the one new audio
   file as that pass's render and refuses if there are several. It also refuses a file Live is
   still writing, so wait for the export to finish. When it finishes, run
   **Stem Export: Next Pass**; the tool claims that render, sets up the next pass, and tells you
   which one it is. Repeat until the last pass, which is a full-mix **Master reference**. **Do not
   change the arrangement selection (the export range) between exports**: every render must be
   exactly the same length, and Next Pass rejects one that is not. Each render is checked
   when you run Next Pass, so a bad one is caught at once and only that pass needs redoing.
7. **Run Stem Export: Finish.** Your original mutes, solos and Master devices are put back, the
   renders are levelled and written, and the results dialog shows the output folder and the null
   residual. If the result is not clean, read the problems listed. Some are fixable and you can
   run Finish again — for example a file that would clip after the gain is applied, which is
   reported rather than written. **A genuine null failure is not**: the Set is already restored
   by then, and Next Pass only says it was the last pass, so the way out is **Abort**, then run
   Stem Export again and redo the exports. If a track was renamed or deleted between your last
   export and Finish, the restore reports what it could not put back and Finish still writes your
   stems; the run record is kept so **Abort** can finish restoring once the Set matches again.
   If anything goes wrong mid-way, **Stem Export: Abort** puts the Set back exactly as found.
8. **Move the folder.** Drag `<storage folder>/out/<song>/` into your library (for example
   `Content/Stems/`). The extension cannot do this step for you; see the limitations. The folder
   also holds `<song> (MASTER REFERENCE).wav`: that is the premaster mix used for the null test, **not
   a stem**, so leave it out of (or delete it from) the library. Live
   chooses the storage folder and the SDK documentation does not say where it is, so the dialogs
   print the exact path (when a run starts, and again at Finish).

### Why these choices

**Stems are premaster.** The tool bypasses the Main track's enabled devices for the run, so each
stem is the mix *before* the master chain, and restores them afterwards (read back and checked,
like your mutes). That is what you want to perform with: you apply your own processing live, and
the stems still sum cleanly.

**One gain per song.** The stems are summed, and a single gain is derived from that sum (to the
target loudness, within the true-peak ceiling), then applied to every stem, every extra and the
Master reference alike. Levelling each stem separately would wreck the balance between them, and
the stems would no longer add up to the song. With one gain, they still do.

**The null test.** The levelled stems are summed and subtracted from the (equally levelled)
Master reference. If the result is silence, the stems account for everything in the mix: no track
is missing, none is in two stems, and nothing a mute changed (a sidechain, a send) has quietly
altered the sound. The residual is shown in dBFS, and it must sit far below the reference's own
peak. A silent or near-silent reference is rejected, since it would "null" against anything.

Return tracks are never muted, so reverb and delay tails are meant to land in the stem that fed
them. That relies on a muted track also silencing its sends, which is how Live behaves but has
not been verified here; the null test is the check.

---

## 3. Limitations (read these)

- **Sidechain tap points are not exposed by the SDK**, so the `post-mixer-key` check cannot
  fire. A sidechain whose tap is **Post Mixer** takes its key *after* the key track's mute, so if
  that key track is excluded from a pass, the sidechained track **loses its ducking in that
  pass, and the pre-flight check will not warn you**. In principle the null test then fails (the
  stems no longer sum to the Master reference), but that has not been tried. This is not
  hypothetical: **the project this was built for has exactly one**, the `Bass` group ducking from
  `Kick`. Check that pass by ear. (Details: `docs/superpowers/notes/sidechain-taps.md`.)
- **The extension stops at `storageDirectory/out/<song>/`.** The SDK restricts extensions to their
  own storage and temp directories (and forbids working around that), so it cannot write to
  `~/Documents` or your library. Moving the folder is a manual step by design.
- **`live.ts` has never been run against a real Live.** Nothing in this project has. The SDK-facing
  code is a thin layer over fakes-tested logic, and it is exactly where a wrong assumption would
  hide.
- **Pass advancing is manual.** The plan was to watch the export folder and advance on each
  render, but whether an extension stays resident, and whether a file watcher keeps firing while
  Live is in use, was meant to be settled by a lifecycle spike
  (`docs/superpowers/notes/lifecycle-spike.md`). **That spike has not been run.** So you run
  **Next Pass** yourself after each export. The code is arranged so a watcher could call the same
  step later; none exists.
- **The Set's name is not available**, hence the Song field (step 2). Two songs given one name
  share one saved mapping and one output folder. An in-progress run is found by looking at the
  run records themselves, not the name, so changing the name mid-run cannot strand it.
- **The `groupTrack` same-object assumption** in `src/snapshot.ts` is unconfirmed against a real
  Set. Group membership and track keys rely on a group's children returning the *same object* as
  the group's own entry in the track list. If Live returns fresh wrappers each time, groups will
  be mis-keyed.
- **Run records are matched to the open Set by track names only.** The SDK exposes no Set
  identity. If you abandon a run and open a *different* project whose tracks include all of the
  record's (another song with Kick, Bass and Pad, say), Abort will find the record, judge that it
  matches, and apply the old mutes to the wrong Set. Abort's result dialog names the song the
  record came from; if that is not the Set you have open, discard the record instead of
  restoring.
- **Per-stem filename suffixes** (for example ` (Live)` appended to one stem's file name) are
  supported by the manifest but have no UI. They can only be set by editing the saved mapping,
  `<storage folder>/manifests/<song>.json`, by hand.
- The extension never reads or writes a `.als` file, and the saved mapping lives in the
  extension's storage folder, not beside the project.
