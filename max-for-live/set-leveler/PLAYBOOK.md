# Setting the master after levelling

Run this after Apply. Set Leveler gets the tracks even. This gets them loud enough. It's by hand on purpose: the
Limiter's own meter is the only real gain reduction reading, and the device can't see it.

## Chain

Main track, in this order. Leave the Main fader at 0, because gain after the Limiter can undo its ceiling.

1. **Utility** at 0 dB. Your overall trim, if you ever want one.
2. **Limiter**: Ceiling -0.3, Auto release, Link 100%, 3 ms lookahead. Try True Peak mode if it doesn't add noticeable
   latency or change the sound.
3. **Your meter**, like Youlean, last so it reads what leaves the Limiter.

Keep **"Make It Loud" off**. Its Glue adds 6 dB of makeup, so none of the numbers below would hold.

## Makeup

**Limiter Gain = 1 dB + however far your target is below -12.**

| Target | Limiter Gain |
|---|---|
| -12 | +1 |
| -13 | +2 |
| -14 | +3 |

So pressing **Match it** on a weakest link doesn't cost you level: the rule puts it back at the Limiter. The weakest link
then takes that limiting itself, and everything else comes out at the same level.

## Check it

Play the hottest track and a real transition, and watch the Limiter's gain reduction.

| What you see or hear | Do this |
|---|---|
| Under 2 dB on hot moments, and not loud enough | Add 0.5 to 1 dB of Limiter Gain |
| About 2-3 dB on hot moments | You're done. Any more level comes from the venue's system |
| Over 3 dB on most tracks, or it sounds squashed | Back off the Limiter Gain and turn up the system |
| One track pumps and the rest are fine | That's the weakest link: trim that clip by hand, set it to Leave alone, or fix the song |
| Only transitions hit hard | Normal, since two tracks add about 3 dB. Pull one down as you mix |

## What to expect

Estimates at target -12, from simulating 19 Halloween clips rather than from Live's Limiter. Loudness is the loudest
stretch, so read it as short-term LUFS on the meter.

| Limiter Gain | One track | Two tracks in a transition | Worst limiting on one clip |
|---|---|---|---|
| 0 | -12 | about -9.2 | 2.3 dB |
| +1 | -11 | about -8.6 | 3.3 dB |
| +2 | -10 | about -8.2 | 4.3 dB |

No setting gives every track 1-2 dB: many stay under the ceiling at these levels, and the worst peaks go past it.
