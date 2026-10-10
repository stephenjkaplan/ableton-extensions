# Stem Export

An Ableton Live Extension that turns a finished track into a folder of correctly named, levelled,
null-tested premaster stems, ready to drop into a live-performance library.

It lives in `extensions/stem-export/`. It does the tedious parts (muting the right tracks for each
pass, bypassing the Master, naming files, levelling, checking the sum) and leaves the actual
rendering to Live's own Export Audio/Video.

> **Status: written and unit-tested, never run in Live.** Everything here is covered by tests
> against fakes. `src/live.ts`, the only module that talks to the SDK, has not been run against
> a real Live Set. See [Limitations](#3-limitations-read-these).

---

## 1. Installing into Ableton

### What you need

- **Live 12 Suite Beta, version 12.4.5 or later.** Extensions only exist in the Live 12 beta.
  The stable release (12.4.6 at the time of writing) has no `Contents/Helpers/ExtensionHost`
  and **will not run this extension**.
- **Node 24.16 or later**, for the SDK's command-line tools (`node -v` to check). Installing a
  built `.ablx` does not need Node; building one does.

### Joining the beta

Join the Live beta program from your Ableton account, install "Live 12 Suite Beta" alongside
your stable Live, and update it to 12.4.5 or later. The Extensions SDK ships with that beta
download; the two tarballs this project needs are already vendored in
`extensions/stem-export/vendor/`.

### Where the `.ablx` comes from

You build it. There is no published download.

```bash
cd extensions/stem-export
npm install
npm test            # optional, ~240 tests
npm run package     # builds for production and writes stem-export-1.0.0.ablx
```

The archive is `extensions/stem-export/stem-export-1.0.0.ablx`.

### Installing it

In Live Beta: **Settings > Extensions**, then either drag the `.ablx` onto that pane or use
**Install Extension**. The commands then appear when you right-click an audio or MIDI track.

### Developing

1. In Live Beta, **Settings > Extensions**, switch on **Developer Mode**.
2. Put the path to the Beta's Extension Host module in `extensions/stem-export/.env`:

   ```
   EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/...
   ```

   (`.env` is gitignored; each machine sets its own.)
3. `npm start` builds a dev bundle and launches it in the Extension Host. Leave it running; log
   output appears in that terminal.

---

## 2. The process

The shape of a session, start to finish. The tool's own dialogs explain their buttons.

1. **Finish the track.** Stems are a snapshot of a finished arrangement. The Main track must have
   no enabled devices when you start (the tool refuses otherwise; see below for why).
2. **Tell the tool the song's name.** Live does not expose the Set's name to extensions, so put it
   on the first line of `song-name.txt` in the extension's storage folder. Without it everything
   is filed under "Untitled Set". The mapping dialog tells you when it is using the default.
3. **Run Stem Export...** (right-click any audio or MIDI track). A dialog lists every track.
   Decide what you will **play live** and give each of those tracks to a named stem (Drums,
   `Rhodes - Played`, ...). Everything that is meant to run as **backing** you leave alone.
4. **Let `Backing` collect the remainder.** You never assign Backing. Any audible track you did
   not claim falls into it, and the dialog shows what that is. Tracks you have muted are held
   out of every stem; the dialog says so. A pre-flight panel flags problems, and the host
   re-checks the mapping when you accept: errors block the run, whatever the dialog showed.
5. **Set Live's export destination once**, to the temp folder the dialog shows. Live remembers it.
6. **Export once per pass.** The tool has muted everything except the first pass's tracks. Use
   File > Export Audio/Video (render the Main track, any file name). When it finishes, run
   **Stem Export: Next Pass**; the tool claims that render, sets up the next pass, and tells you
   which one it is. Repeat until the last pass, which is a full-mix **Master reference**.
7. **Run Stem Export: Finish.** Your original mutes, solos and Master devices are put back, the
   renders are levelled and written, and the results dialog shows the output folder and the null
   residual. If anything goes wrong mid-way, **Stem Export: Abort** puts the Set back exactly as
   found.
8. **Move the folder.** Drag `<storage folder>/out/<song>/` into your library (for example
   `Content/Stems/`). The extension cannot do this step for you; see the limitations.

### Why these choices

**Stems are premaster.** The tool bypasses the Master's devices for the run, so each stem is the
mix *before* the master chain. That is what you want to perform with: you apply your own
processing live, and the stems still sum cleanly. It is also why the Main track must be clean
going in: the tool will restore whatever you had, but it will not guess which devices you meant
to keep.

**One gain per song.** The stems are summed, and a single gain is derived from that sum (to the
target loudness, within the true-peak ceiling), then applied to every stem, every extra and the
Master reference alike. Levelling each stem separately would wreck the balance between them, and
the stems would no longer add up to the song. With one gain, they still do.

**The null test.** The levelled stems are summed and subtracted from the (equally levelled)
Master reference. If the result is silence, the stems account for everything in the mix: no track
is missing, none is in two stems, and nothing a mute changed (a sidechain, a send) has quietly
altered the sound. The residual is shown in dBFS, and it must sit far below the reference's own
peak. A silent or near-silent reference is rejected, since it would "null" against anything.

Return tracks are never muted, so reverb and delay tails land in the stem that fed them.

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
- **The Set's name is not available**, hence `song-name.txt` (step 2). Using one name for two
  songs shares one saved mapping and one in-progress record between them.
- **The `groupTrack` same-object assumption** in `src/snapshot.ts` is unconfirmed against a real
  Set. Group membership and track keys rely on a group's children returning the *same object* as
  the group's own entry in the track list. If Live returns fresh wrappers each time, groups will
  be mis-keyed.
- The extension never reads or writes a `.als` file, and the saved mapping lives in the
  extension's storage folder, not beside the project.
