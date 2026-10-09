# Lifecycle spike: results

Status: **TEMPLATE, NOT YET RUN.** The sections below are intentionally empty. They are
filled in by a human running the spike in a live Ableton Live Beta session. Do not infer
answers from the SDK docs.

This spike answers the questions Task 7 depends on: does the extension stay resident between
commands, and does an `fs.watch` started inside a command keep firing while Live is usable?

## Prerequisites

- Node `>=24.16.0` on the PATH (the machine this was scaffolded on had Node 22.23.2; check
  `node -v` first).
- Ableton Live 12 Beta 12.4.5+ at `/Applications/Ableton Live 12 Beta.app`. The stable
  Suite does not ship an Extension Host.
- `extensions/stem-export/.env` contains `EXTENSION_HOST_PATH` pointing at the Beta's
  `ExtensionHostNodeModule.node` (already set; `.env` is gitignored).
- A Live Set with at least one audio or MIDI track that produces sound.

## Steps

1. Open Live Beta and open a Set. Go to **Settings > Extensions** and enable
   **Developer Mode**.
2. In a terminal:

   ```bash
   cd extensions/stem-export
   npm install
   npm start
   ```

   `npm start` builds the dev bundle and launches the Extension Host. Leave this terminal
   open: all `[spike]` console output appears here. Note the timestamp of the
   `[spike] activate() at ...` line.
3. In Live, right-click an audio or MIDI track and choose **Stem Export: spike**.
   The first invocation prints `command #1` and `watching <temp dir>`. Copy the temp
   directory path.
4. Run **Stem Export: spike** two more times, about **one minute apart** each (three
   invocations total). Do not restart `npm start` between them.
5. In Live, open **File > Export Audio/Video**, set the export destination folder to the
   temp directory printed in step 3, and export once (any short range is fine). While the
   export renders, check whether Live remains usable (for example, can you still scroll,
   select tracks, open menus?).
6. Paste the full `[spike]` console output into the sections below, and fill in the answers.

## Question 1: Is module state retained across invocations?

Does `commandCount` increment across invocations (`command #1`, `#2`, `#3`)?

Answer: _(yes / no)_

```
(paste console output here)
```

## Question 2: Is the process resident between invocations?

Does the "seconds since activate" value keep growing across the three invocations (roughly
0s, 60s, 120s from the first command, offset by the time between activate and command #1)?

Answer: _(yes / no)_

```
(paste console output here)
```

## Question 3: Does the watcher fire on a Live render, and does Live stay usable?

After pointing Live's Export Audio destination at the temp directory, does
`[spike] watcher fired #N: ...` appear while Live writes the render? Does Live remain
usable during the export?

Watcher fired: _(yes / no)_

Live usable meanwhile: _(yes / no)_

```
(paste console output here)
```

## Decision

- If **all three are yes**: Task 7 implements the automatic watch loop.
- If **any is no**: Task 7 implements the manual `Next Pass` loop instead. Every other task
  is unaffected.

Decision: _(automatic watch loop / manual Next Pass loop)_
