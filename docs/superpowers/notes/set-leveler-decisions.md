# Set Leveler: calls made during the build

Decisions taken without asking the owner, each with what it costs if wrong, and smaller issues left for later.

## Calls

- Owner ran the spike and all checks passed; undo probe automated instead of owner counting Cmd-Z — less for the owner to do — cost if wrong: none, value logged.
- plan's test expected -20.7 LUFS for a 0.1 amp stereo 1 kHz tone, but K-weighting adds 0.69 dB at 1 kHz, so the correct reading is -20 (EBU's reference: a stereo -23 dBFS 1 kHz sine reads -23 LUFS) — corrected the tests — cost if wrong: every level off by 0.7 dB; cross-checked against ffmpeg on real files.
- copied the biquad filter into measure.ts as streaming code rather than exporting it from stem-export — Global Constraints say not to touch stem-export, and streaming saves memory — cost if wrong: small duplication.
- mono files count as two channels — Live plays mono on both sides, so otherwise they'd read 3 dB quiet and get boosted — cost if wrong: mono clips 3 dB off.
- answers store each clip's file and its host's file, and are dropped if a slot now holds something else — the plan's Record<ClipKey, Role> would silently apply an old answer to a moved clip — cost if wrong: a re-asked question.
- target is saved per Set, and Controller gained start() for Undo after a crash — otherwise a reopened Set re-proposes against -12, and Undo can't enable until Analyze — cost if wrong: small.
- Apply rescans and rebuilds the plan from current gains, and clips under 0.01 dB aren't written — a hand change after Analyze would otherwise be overwritten with a stale value — cost if wrong: none.
- added test/main.test.ts, an end-to-end run of the device against a simulated Live — the plan had no tests here, but a wiring bug costs the owner a round trip in Live — cost if wrong: none.
- Node loads the page by absolute path at startup, and again on open if it isn't ready, rather than loadmess with a fixed path — a device that can be moved, and install paths have spaces — cost if wrong: blank window, seen immediately in Live.
- removed spike/ now, keeping the notes — it's proven and throwaway, and build.mjs replaced it — cost if wrong: recoverable from git.
- UI says "Everything's already at the target" when no change is above 0.05 dB — after Apply the plan otherwise reads "ready to level" with zero changes — cost if wrong: none.
- Final review ran on Opus because Fable requires usage credits on this plan — the most capable model available — cost if wrong: small.
- changed the plan's rule that Undo drops the snapshot even when clips were skipped; it now keeps exactly what wasn't restored — the plan's rule could lose gains for good — a clip gone for good blocks stepping back past that run.
- after Save As, Undo uses the newest other Set's snapshot only if every clip matches exactly, and names that Set beside the button rather than asking in a dialog — the button press is the confirmation — a different Set with identical slots and files could offer a run that isn't its own, visible in the label.
- bridge guards for unsaved Sets, group tracks and "symbol scan" have no test because no Max is available here — the Live test covers them — a miss shows up at once as a failed scan.
- Declined item, two Set Leveler instances writing at once — the owner runs one, and Undo is per Set — cost if wrong: mixed snapshots.
- Declined item, snapshots piling up with no clear option — small files, and keeping them is the safe direction — cost: disk, negligible.
- Declined item, Collect All and Save copying only the .amxd — the device stays in the User Library and clip gains don't need it once applied — cost: a device-missing notice in a collected project.
- Declined item, measuring layers and leave-alone clips too — role changes then never re-measure, and the only cost is time — cost: seconds.
- Declined item, a layer on a clamped host — §4.2 says exact change, and +24 dB clamping is very rare — cost: a rare layer imbalance.
- Declined item, scan speed on very large Sets — DJ sets are about 30 clips — cost: slow scan on big Sets.
- Declined item, Max symbol table growth from unique state chunks — negligible per session — cost: memory, small.
- Declined item, envelopes, devices, fixed +2 dB limit, Cmd-Z merging — spec covers or excludes them — cost: known limits in README.

## Deferred

- Undo messages list full file paths; add name to snapshot entries.
- a target typed while busy is dropped; disable the input during busy phases.
- empty Set saves layerTracks [] so the lane question never returns.
- blank main area during scans and Apply, and a stale message can sit there.
- afconvert has no timeout, so a dead mount could hang Measuring.
- warp changes after Analyze aren't detected.
- snapshot writes aren't fsynced.
- jweb status messages post Unhandled Message warnings in the Max window.
