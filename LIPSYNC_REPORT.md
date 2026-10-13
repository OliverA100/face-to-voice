# Lip-sync report

Step 1 of the lip-sync pass: measurements of the live app, before any fix. Every number below was measured on
production code: facetovoice.com itself, or a Vercel preview of the same commit (ca55fb5) that adds only a
secret-gated BotID skip so scripted browsers can press Speak and Chat. No app code was changed for this step.

Sign convention everywhere: **negative = the mouth is early, positive = the mouth is late.** All times are in ms.

## The short version

1. **The mouth runs ahead of the voice everywhere.**
   - How far: about 50–75 ms on a Mac's speakers, measured in the room (screen + mic).
   - Where it comes from: the app's own timing, not the speakers or the screen. Each browser's own estimate of its speaker delay is within 20 ms of the truth.
   - The cause: a fixed 80 ms head start (`LIPSYNC.lead`) applied to the *whole* mouth, so releases come early too, not just the closing movements.
2. **p/b/m are wrong in two opposite ways.**
   - Most p/b/m: the lips close about 95 ms before the sound stops, and part about 20–50 ms before the burst.
   - About 1 in 6 (the bad case): the lips stay sealed for 250–440 ms across a short word and open at least 150 ms late. Short words between closures ("but" in "but Bob bought", "Piper picked", "maybe", "mostly") are never mouthed: these are the "words that look weird".
3. **Bluetooth (AirPods) adds a further 75–90 ms of early mouth.** The browsers report a Bluetooth delay, but under-report it (about 165 reported vs about 245 real).
4. **iPhone Safari over-reports its delay by about 50 ms.** That pushes the mouth about 50 ms later than on a Mac, which today happens to hide most of the early lead on phones. Once the lead is fixed, phones would be about 50 ms late unless this is corrected too.
5. **f/v:** the lower lip reaches the teeth 15–65 ms before the hiss (median per path).
6. **Vowels:** centred well (median within ±20 ms) but scattered: 10% of vowels are off by 50–60 ms or more.
7. **No difference between first-time and cached lines.** Audio underruns are handled acceptably: the mouth goes still in the gap and catches up. Live chat behaves like Speak.
8. **Lip sync costs about 0.13 ms of script per frame** with the CPU slowed 4×. No frames are dropped.

## How it was measured

Fresh tools in `qa/lipsync/` (see its README). None of them reuse the old rig or `/dev/lipsync`.

| Piece | What it does |
|---|---|
| `inject.js` | In-page recorder. Copies every node connected to the speakers into a tap, so it records exactly what the page plays. Grabs the canvas right after each render. Stamps both on the page's AudioContext clock. Also logs the app's own mouth values when `?debug` is on. |
| `lib.mjs`, `speak.mjs`, `chat.mjs`, `replay.mjs` | Drive Chrome and Firefox (puppeteer-core) and real Safari (`safari.mjs`, WebDriver) through the site's own buttons: Find my voice, Use voice, Speak, Meet → Chat. `replay.mjs` replays saved real lines (no credits). |
| `truth.py` | Audio ground truth with no app code: a forced aligner (wav2vec2) on the audio actually played, plus acoustic landmarks: closure onset and burst for p/b/m, hiss onset for f/v/th, loudness peak for vowels. |
| `mouth.py` | The mouth from pixels: dark interior + teeth between the lips, measured as opening height. |
| `events.py`, `summary.py` | Pair each audio event with the mouth; pool the results per path. `--app` uses the app's own values instead (dark skin). |
| `room.mjs`, `room.py` | "What a person sees and hears": macOS `screencapture` records the screen and the Mac's mic on one clock. A flash-and-beep page (`calibrate.html`) measures each device's real delay. |
| `phone.py` | An iPhone filmed by the Mac's camera (QuickTime), corrected for the camera's own delay with a hand clap. |

**Checks on the tools:**
- **Recorder self-check:** on `calibrate.html`, every frame grab matched its timestamp, within one frame, in Chrome, Firefox and Safari.
- **Pixels vs app values:** on the same runs they agree to within 10–20 ms. The app's values lead slightly, because the speed limit is applied after them.
- **Room capture:** `screencapture` was chosen over ffmpeg's avfoundation input, which dropped about 14% of the mic samples under screen-capture load.

**Coverage:**
- **Characters and expressions:**
  - A, the default face: neutral, plus Angry.
  - B, a random face: angry.
  - C, a random face with very dark skin: contempt, Tired, Happy. Measured with the app's values; pixels can't see her open mouth.
- **Line types:** plosives, f/v, rounded, wide, long, numbers, names, pauses, m-heavy, and the preset line.
- **Volume:** 61 Speak requests and 7 live chats. Today's design budget (4) is used up.

## Results by path (pooled events)

From `uv run summary.py --md`. Format: median (p90 |…|, the worst 10% are at least this far off).

*Corrected in Step 2:* frames are now placed with `currentTime − outputLatency`, the rule the room recordings back up.
The first version used `getOutputTimestamp`, which in Firefox and Safari leaves the output delay out. That made those two browsers look 15–20 ms less early than they were (Firefox −25 → −45, Safari −35 → −50). The device tables below were never affected.

| Path | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Speak, first-time (streamed), Chrome | 41 | -55 (p90 \|70\|) | -20 (p90 \|154\|) | -95 (p90 \|148\|) | -147 (p90 \|285\|) | -7 (p90 \|57\|) | -55 (p90 \|117\|) | 234/259 |
| Speak, cached, Chrome | 10 | -50 (p90 \|55\|) | -27 (p90 \|152\|) | -90 (p90 \|149\|) | -148 (p90 \|248\|) | -9 (p90 \|59\|) | -36 (p90 \|117\|) | 52/55 |
| Speak, cached, Firefox | 5 | -45 (p90 \|55\|) | -32 (p90 \|155\|) | -81 (p90 \|148\|) | -148 (p90 \|250\|) | -7 (p90 \|54\|) | -31 (p90 \|116\|) | 40/43 |
| Speak, cached, Safari | 5 | -50 (p90 \|58\|) | -11 (p90 \|154\|) | -81 (p90 \|149\|) | -142 (p90 \|333\|) | -3 (p90 \|50\|) | -5 (p90 \|115\|) | 40/43 |
| Real lines replayed, streamed pace, Chrome | 6 | -45 (p90 \|55\|) | -42 (p90 \|153\|) | -76 (p90 \|149\|) | -147 (p90 \|266\|) | -19 (p90 \|59\|) | -106 (p90 \|117\|) | 72/76 |
| Real lines replayed, Firefox | 12 | -45 (p90 \|55\|) | -37 (p90 \|153\|) | -81 (p90 \|149\|) | -147 (p90 \|244\|) | -15 (p90 \|57\|) | -86 (p90 \|119\|) | 132/145 |
| Real lines replayed, Safari | 5 | -50 (p90 \|61\|) | -37 (p90 \|154\|) | -79 (p90 \|147\|) | -156 (p90 \|317\|) | -5 (p90 \|56\|) | -63 (p90 \|118\|) | 62/66 |
| Slow network (underruns), Chrome | 2 | -42 (p90 \|44\|) | -18 (p90 \|153\|) | -143 (p90 \|149\|) | -181 (p90 \|293\|) | +2 (p90 \|51\|) | -29 (p90 \|114\|) | 26/27 |
| Live chat, Chrome | 4 | -50 (p90 \|68\|) | -5 (p90 \|152\|) | -90 (p90 \|149\|) | -157 (p90 \|315\|) | +5 (p90 \|54\|) | -23 (p90 \|116\|) | 22/26 |
| Live chat, Firefox | 4 | -58 (p90 \|64\|) | -25 (p90 \|164\|) | -122 (p90 \|150\|) | -164 (p90 \|244\|) | -7 (p90 \|61\|) | -80 (p90 \|116\|) | 24/26 |
| Live chat, Safari | 1 | -65 (p90 \|65\|) | +62 (p90 \|136\|) | -116 (p90 \|137\|) | -208 (p90 \|367\|) | +0 (p90 \|46\|) | -64 (p90 \|64\|) | 4/5 |

**What the columns mean:**
- **Whole-line lag:** the best match between the opening and the loudness over the whole line.
- **Closing starts:** when the lips begin moving toward a p/b/m seal, relative to the sound stopping. The target is −60 to −100.
- **The |150| p90s:** these are real. They come from the long-seal cases (problem 2b). The search window ends at 150 ms, so they read as "150 or more".
- **About this page's clock:** these in-page numbers place each frame where the browser *thinks* its sound is heard. The device tables below show what is really heard.

## Results on real devices (screen + microphone)

The flash-and-beep page draws the flash when the browser thinks the beep is heard. The table shows how far the screen is from what the mic hears (± one 60 Hz frame).

| Device / output | Browser | Browser's reported delay | Flash on screen vs beep heard | Real delay (about) |
|---|---|---|---|---|
| MacBook speakers | Chrome | 24 | -7 | ≈ 30 |
| MacBook speakers | Firefox | 22 | +3 | ≈ 20 |
| MacBook speakers | Safari | 16 | -20 | ≈ 35 |
| AirPods (Bluetooth) | Chrome | 168 | **-75** | ≈ 245 |
| AirPods (Bluetooth) | Safari | 160 | **-88** | ≈ 250 |
| iPhone speaker (filmed, ±20) | iOS Safari | n/a (not instrumented) | **+50** | ≈ 50 less than it thinks |

The same plosive line, filmed off the real screen against the Mac's mic:

| Output | Browser | Sealed | Lips part vs burst | Seal vs sound stops | Whole-line lag |
|---|---|---|---|---|---|
| Speakers | Chrome | 17/17 + 10/10 | -65 / -39 | -89 / -77 | -65 / -70 |
| Speakers | Firefox | 17/17 | -49 | -87 | -50 |
| Speakers | Safari | 17/17 | -68 | -116 | -75 |
| AirPods | Chrome | 17/17 | -78 | -90 | -75 |
| AirPods | Safari | 17/17 | -27 | -131 | -140 |

**iPhone (filmed):** the mouth is about 30 px wide in the film, so per-line results are rough: −25 and −40 ms on two lines, with the third unreliable. The flash calibration (+50 ms) is the solid iPhone number.

## Problems found

| # | Problem | Evidence | Cause | Severity | Fix (step) |
|---|---|---|---|---|---|
| 1 | **The whole mouth leads the voice** | 25–60 ms early in-page; 50–75 ms in the room, every browser, Speak and Chat | `LIPSYNC.lead = 0.08` (`web/src/lib/lipsync/evaluator.ts:16`) shifts the entire evaluation (`LipSync.tsx:67`), releases and openings included. The browsers' own clocks are accurate (device table), so this is the app. | **High**: the main "out of sync" | Step 2: drop the global lead to what the measured delay needs. Anticipation only on the closing and rounding side. |
| 2a | **p/b/m: lips close too early and part before the burst** | seal −64 to −107, release −5 to −47 (room −39 to −68); closing starts about 150 ms before the silence (target 60–100) | The global lead, plus the closure cue ending at burst − `closureOffShift` (0.02, `evaluator.ts:76,436`) and fading over 30 ms; the cue starts at onset − `closureOnShift` − 60 ms attack | **High** | Step 2: release on the burst, closing begins 60–100 ms early per sound |
| 2b | **Short words between closures aren't mouthed** (lips stay sealed 250–440 ms, open ≥150 ms late) | About 1 in 6 closures (24 of 144 on Chrome first-time); seen by eye in "but", "Piper", "maybe", "mostly", "stop.", "mm"; live: a phrase-final m about 150 ms late | Probable: closure dominance + the seal weight suppress the short vowel between two closures. The lip speed limit (150 mm/s, `evaluator.ts:157`) can't open and close again in under about 120 ms. To confirm with the offline replay in Step 2. | **High**: the "weird words" | Step 2 (timing) + Step 3 (blending neighbouring sounds so vowels carry the mouth) |
| 3 | **Bluetooth delay is under-reported** | AirPods: browsers report 160–168, real ≈ 245 → an extra 75–90 ms early | Browser/OS (`outputLatency` / `getOutputTimestamp` miss part of the Bluetooth path) | Medium (common on phones) | Step 2: extra correction when the reported delay looks like Bluetooth (≥ 100 ms), and the Sync slider documented |
| 4 | **iPhone Safari over-reports its delay** | Flash +50 ms after the sound (±20) | iOS Safari's `getOutputTimestamp` path (the player's Safari fallback, `player.ts:103-121`) | Medium: hidden today by problem 1, appears once 1 is fixed | Step 2: a per-platform correction, re-measured on the phone |
| 5 | **f/v lip-to-teeth too early** | −14 to −64 median per path | The global lead, plus the FF cue anticipated by 20 ms and its audio-anchored start | Medium | Step 2 (timing), Step 3 (shape) |
| 6 | **Vowel peaks scattered** | median within ±20, but p90 off by 50–60 | Letter-spread stamps (v4 spreads letters evenly within a word) + peak snapping | Medium | Step 3: phonemes + blending of neighbouring sounds |
| 7 | **Chrome's audio clock moves in 10.7 ms steps** | `ctx.currentTime` steps of 512 samples at 48 kHz while frames come every 8.3 ms | Chrome. The mouth clock reads `ctx.currentTime` | Low (up to 10 ms jitter) | Step 2: interpolate with `getOutputTimestamp` + `performance.now()` |
| 8 | **Safari on a Mac draws the face at 60 fps** (Chrome 120, Firefox about 94) | Frame logs | Safari | Low (coarser motion) | None needed for timing; noted |
| 9 | **Rounded vowels read weakly from the front** ("who", "through") | Frame strips | Shape, not timing | Medium (visual) | Step 3: shape re-tune + contact sheet |
| 10 | **Spelling-based rules for names and unusual words** | Not yet confirmed visually ("Siobhan", "Nguyen" strips saved) | Letter rules (`lipsync-en.ts`), no dictionary | Medium | Step 3: CMUdict phonemes, letter rules as the fallback |

**Hypotheses from the plan that did not hold:**
- **First-time streams:** no measurable difference from cached lines. The early words are not worse.
- **Underruns:** the mouth goes still during the silent gap and its clock catches up when the sound resumes. Behaviour is acceptable, so no fix is planned.

**Performance baseline** (Chrome with a phone screen and the CPU slowed 4×, a long line playing):
- 120 fps idle and speaking, no frames over 33 ms.
- Script per frame: 0.17 ms idle, 0.30 ms speaking (0.26 / 0.67 ms at 12×).

## Not covered yet

- **Android Chrome:** no device or emulator. Chrome's mobile emulation was used for the frame-cost test only.
- **iPhone mouth-level offsets:** rough (camera resolution). The device delay is solid.
- **More characters:** about 8 were planned; 3 are done (plus four expressions). Light-skin characters were held back by the 4-a-day design budget, and by my scripts having used up the Find my voice limit on your IP (fixed: runs now reopen saved characters).
- **Old-rig cross-check:** replaced by the pixel-vs-app-value cross-check (independent measures, agreeing within 10–20 ms).

## Re-running

See `qa/lipsync/README.md`. In short: `node speak.mjs …`, `node chat.mjs …`, `node replay.mjs …`, `node room.mjs …`, then
`./analyse.sh '<runs>'` and `uv run summary.py --md`. The saved real lines (`qa/lipsync/out/clips/`) give the identical audio for the before/after comparison in Step 5.


---

# Step 2: timing fixes

All timing changes are measured on the same saved production lines, before and after. `?lipsync=v1` puts the old timing back on the same page for comparison (temporary).

## What changed and why

| Change | Where | Fixes |
|---|---|---|
| **Mouth lead 80 → 30 ms** | `evaluator.ts` `LIPSYNC.lead` | Problem 1 (the whole mouth early) and the early releases (2a). With the closures placed right (below), 30 ms puts the release on the burst as drawn in all three browsers. The early closing movement per sound stays: closures start forming attack + closureOnShift before their silence. |
| **A pause counts as a syllable between two closures** | `evaluator.ts` `syllableBetween` | Problem 2b, the main cause of "but" not being mouthed. After "peppers," the phrase before trailed off more than 10 dB below "but"'s vowel, so every quiet moment in the pause was rejected. The b was pushed past its own vowel, and Bob's closure after it. |
| **A p/b/m after silence spans up to its burst** | `evaluator.ts` `closureSpan` | Same case when the pause is clean silence (nothing to measure a drop from): the cue used to stay on its late stamp. |
| **Phrases re-anchored after pauses when far off** | `evaluator.ts` `placePhrases` (Speak only; live chats have their own anchors) | 17 of 65 phrase starts were more than 80 ms off their sound, up to 300 ms ("mood, mostly", the pauses line). Only offsets over 30 ms are moved; smaller ones are left to the snapping. |
| **f/v and th start 25 ms earlier** | `evaluator.ts` `hissOnShift` | Problem 5. The lip reaches the teeth as the hiss begins. |
| **One heard clock** | `clock.ts` (player and live) | Problems 3, 4 and 7. Time carried between Chrome's 10.7 ms clock steps; +80 ms when the reported delay looks like Bluetooth (≥ 100 ms); −50 ms on iPhone Safari; read once per frame. |
| **Testable mouth** | `envelope.ts`, `mouth.ts` (from `player.ts`, `LipSync.tsx`, same code) | Lets `qa/lipsync/bench.sh` run the app's exact mouth on saved lines with no browser: 41 real lines in seconds. |

**Measured, not changed:**
- **First-time vs cached:** no difference, so the player's start-up buffer stays as it is.
- **Underruns:** handled acceptably; the mouth goes still in the gap and catches up.
- **Faster lip openings** (higher speed and acceleration limits): no gain on the unmouthed words, so the "jumpy" fixes stay.

## Before → after, same lines (in-page, pooled)

Lines: A-plosive, A-round, A-long, B-plosive, B-mumble, C-plosive-happy. Production vs a local production build of the branch.

| Path | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Before, Chrome (prod) | 6 | -45 (p90 \|55\|) | -42 (p90 \|153\|) | -76 (p90 \|149\|) | -147 (p90 \|266\|) | -19 (p90 \|59\|) | -106 (p90 \|117\|) | 72/76 |
| **After, Chrome** | 6 | **+5 (p90 \|10\|)** | **+8 (p90 \|140\|)** | -49 (p90 \|145\|) | -109 (p90 \|232\|) | -10 (p90 \|44\|) | -49 (p90 \|116\|) | 69/76 |
| Before, Firefox (prod) | 6 | -42 (p90 \|52\|) | -37 (p90 \|150\|) | -81 (p90 \|149\|) | -143 (p90 \|245\|) | -15 (p90 \|57\|) | -51 (p90 \|119\|) | 71/76 |
| **After, Firefox** | 6 | **+5 (p90 \|8\|)** | **+7 (p90 \|145\|)** | -39 (p90 \|145\|) | -110 (p90 \|266\|) | -12 (p90 \|50\|) | -13 (p90 \|112\|) | 69/76 |
| Before, Safari (prod) | 5 | -50 (p90 \|61\|) | -37 (p90 \|154\|) | -79 (p90 \|147\|) | -156 (p90 \|317\|) | -5 (p90 \|56\|) | -63 (p90 \|118\|) | 62/66 |
| **After, Safari** | 5 | **+0 (p90 \|5\|)** | **+7 (p90 \|146\|)** | -49 (p90 \|137\|) | -138 (p90 \|299\|) | -9 (p90 \|51\|) | -52 (p90 \|106\|) | 60/66 |

**Offline bench** (all 41 saved lines, the app's exact mouth code, a perfect clock, `bench.py`):
- **Lips part vs burst:** −47 → +6 ms.
- **Seal:** −65 → −30 ms.
- **Releases more than 100 ms late:** 31 → 21.
- **Vowel peaks:** −25 → −16 ms.
- **Lip speed and acceleration:** unchanged (137 mm/s, 3.6 m/s²).

## Before → after on the real screen with the Mac's mic (speakers)

Lips part vs the burst on the plosive lines:

| Browser | Before | After |
|---|---|---|
| Chrome | −65 / −39 | **−10 / −10** |
| Firefox | −49 | **−3** |
| Safari | −68 | **−29 / −25** |

- **Seals:** 17/17 on every run.
- **Seal timing:** before the sound stops by 22–55 ms (was 77–116).
- **Whole-line lag:** 15–40 ms early (was 50–75). That match is smeared by room echo; the burst-based release above is the reliable one.

Safari stays the earliest. Its own speaker-delay report is about 20 ms short on this Mac (calibration, Step 1). A further +20 ms for desktop Safari would centre it, but it rests on one Mac, so it isn't applied.

## Performance

Script per frame while speaking, Chrome with a phone screen and the CPU slowed 4×: 0.33 ms on production, 0.32 ms on the new build. Both at 120 fps with no dropped frames.

## Still open (for Step 3 and 5)

- **The long-seal tail:** about 1 in 10 p/b/m still opens more than 100 ms late in fast speech (the angry take, C's voices: "peppers", "before") and on m-heavy lines ("mostly", "maybe"). Some are quirks of my measure: "mm" is a hum with closed lips, and "stop!" ends in silence. Fast sequences need Step 3's blending of neighbouring sounds and phonemes.
- **Not re-measured after the change:** Bluetooth and iPhone. Their corrections come from the Step 1 calibrations and are re-checked in Step 5.
- **Live chats** use the new clock. Their re-measurement is Step 4.
