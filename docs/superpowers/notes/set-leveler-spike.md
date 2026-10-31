# Set Leveler spike results

Run by the owner on 2026-10-31 in Live 12.4.15 Suite (Max 9.1.5), on a throwaway Set, using a device
generated from text. Results were logged to a file by the device, so these are recorded values.

## What worked

- A generated `.amxd` (header in `scripts/build-amxd.mjs`, plain JSON patcher, no freezing) loads.
- `node.script` runs on Node 22.18, found both by absolute path and by bare name beside the device.
- `v8` runs with `LiveAPI`, found both by absolute path and by bare name beside the device.
- `v8` reads and sets `gain`. Restoring a saved raw value reads back exactly (`0.4000000059604645`).
- `jweb` in a subpatcher window opened with `pcontrol` loads a page, and a click there reaches Node
  and Node's reply reaches the page. `---` send and receive names work between them.
- `live_set file_path` gives the saved Set's path.
- Walking `tracks`, `clip_slots` and `arrangement_clips` took 7 ms on a 2-track Set.

## Findings

- **Gain:** `gain` runs 0.0 to 1.0. 0.0 is -inf, 0.40 is 0 dB, 1.0 is +24 dB. From 0.40 up it's a straight
  line of 40 dB per unit. Below that it curves, so `src/gain-map.ts` holds the table. The bottom non-zero
  step measured is 0.01 = -57.4 dB. Both clips gave the same table.
- **`warp_markers`** arrives as a one-item array holding a JSON string:
  `{"warp_markers": [{"sample_time": 0.0, "beat_time": 0.0}, {"sample_time": 22.35, "beat_time": 32.03}]}`.
  `sample_time` is seconds. Unwarped clips also report markers.
- **Unwarped clips:** `loop_start` and `loop_end` looked like seconds (`loop_end` 20.87 on a 20.87 s file),
  while `end_marker` was 32. The design measures the whole file for these, so nothing depends on this.
- **Cmd-Z:** three separate writes to one clip, 200 ms apart, came back with one `undo`. It also went back
  past the sweep before it, so Live seems to merge repeated changes to one clip. How it treats changes
  across many clips wasn't tested, so the device's own Undo stays the one to rely on.
- **Speed:** a 101-step sweep finishes in about 20 ms, too fast for Live's clip view to show it moving.
- **Window:** a subpatcher opened in patching view shows its other objects over `jweb`. The real device
  must open in presentation mode with only `jweb` in it.
