# Sidechain tap points: not reachable

Status: **the `post-mixer-key` check is UNAVAILABLE until the Extensions SDK exposes routing.**

## Finding

The SDK (`docs/sdk/sdk-api.d.ts`, `@ableton-extensions/sdk` 1.0.0-beta.1) has no accessor for a
device's sidechain source or tap point. The relevant surface is only:

- `Device`: `name`, `parameters`
- `DeviceParameter`: `name`, `min`, `max`, `isQuantized`, `defaultValue`, `valueItems`,
  `getValue()`, `setValue()`
- `RackDevice` adds `chains`; `Simpler` and `DrumRack` add sample/chain access. None adds routing.

A case-insensitive search of the `.d.ts` for `sidechain`, `side-chain`, `routing`, `tap`,
`audioFrom`/`audioTo` and `monitoring` returns no matches. The only route left would be to
infer a sidechain from `device.parameters` names or `valueItems` on a compressor; that was not
attempted (it would need a real Live Set, and parameter lists do not carry the source choice or
the Pre FX / Post FX / Post Mixer tap in any documented way). Do not treat that as confirmed
either way.

## Consequence

- `bridgeTaps()` in `extensions/stem-export/src/live.ts` returns `[]`.
- The validator rule `post-mixer-key` therefore **cannot fire** on a real Set. Its code and tests
  are kept: they take an explicit tap list and are correct; they will work as soon as taps are
  available.
- An empty tap list means "unknown", **not** "no Post Mixer taps". Nothing in the UI may present
  it as a clean result.
- Concrete miss for this user's project (Learning to Feel): it has exactly one `Post Mixer` tap,
  the `Bass` group ducking from `Kick`. A Post Mixer sidechain follows the source's fader and
  mute, so muting `Kick` in a stem pass changes how `Bass` is ducked and the stems stop summing
  to the Master. This will go **undetected by the validator**. The only remaining safeguard is
  the null test in `finalize` (`residualDb`), which will catch it after rendering.

## Revisit when

The SDK adds anything like a device/track routing or sidechain accessor. Then replace
`bridgeTaps()` with a real read and no other code changes should be needed.
