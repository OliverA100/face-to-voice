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
| Live chat, Chrome* | 4 | -70 (p90 \|80\|) | -19 (p90 \|150\|) | -115 (p90 \|145\|) | -174 (p90 \|342\|) | +5 (p90 \|58\|) | -78 (p90 \|112\|) | 22/26 |
| Live chat, Firefox* | 4 | -58 (p90 \|64\|) | -43 (p90 \|159\|) | -112 (p90 \|150\|) | -161 (p90 \|273\|) | -4 (p90 \|59\|) | -25 (p90 \|116\|) | 23/24 |
| Live chat, Safari | 1 | -65 (p90 \|65\|) | +62 (p90 \|136\|) | -116 (p90 \|137\|) | -208 (p90 \|367\|) | +0 (p90 \|46\|) | -64 (p90 \|64\|) | 4/5 |

\* *Corrected in Step 4.* In Chrome chats the head pitches for seconds at a time (probably following the scripted mouse,
which rests below the face after a click), and the lips left the fixed mouth crop: the pixels read the chin. Frames
like that are now left out (`mouth.py` "clipped"), and runs that lose over half their events to it (three of the four
Chrome chats) use the app's own per-frame mouth values, as the dark-skinned face does (the drawing delay of about
12 ms isn't in them). Two Firefox chats lost a few seconds each. The live lag is −50 to −70 either way, and every
other row is unchanged.

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
- **Live chats** use the new clock. Their re-measurement is Step 4 (below).


---

# Step 3: mouth shapes (part 1)

## What changed

| Change | Where | Why |
|---|---|---|
| **Phonemes from the CMU Pronouncing Dictionary** | `web/src/data/phonemes.json` (BSD-2, NOTICE, `third_party/cmudict`), `lib/server/pronounce.ts`, `lib/lipsync/phonemes.ts`, `cues.ts` | The letter rules shape 108,011 of the dictionary's 124,926 words differently, and the differences matter. Endings were missing: "maybe" had no final "ee", and "go", "my", "eight" had no glide. Vowels were wrong: "all", "thought", "water" were wide instead of rounded; "who" had an "ee"; "third" was spread. Names were wrong: Siobhan, Nguyen, Gloucester, Worcestershire. |
| **Phonemes sent per line, not downloaded** | speak route | The dictionary stays on the server, and each Speak response (fresh or cached) starts with one NDJSON line holding its own words' phonemes. The browser downloads nothing extra. Words not in the dictionary ("Aoife") keep the letter rules. |
| **Closure dips scored in dB, searched up to 120 ms before the stamp** | `evaluator.ts` `snapDbPerS`, `snapBefore` | A word stamped late ("bat" in "blue bat", 120 ms) had its real silence out of reach, and in linear loudness a soft consonant next to the stamp beat it. |
| **Jaw split from lip shape** | `evaluator.ts` `shapeGate`, `LIPSYNC_PARTS.jawSplit`, `mouth.ts` | The jaw morph (`roles.jawOpen`) follows the loudness gate as before. Every other morph (the lips' shape) follows a softer gate on the same local loudness: none in silence, full at 30% of the loudest moment nearby. A quiet syllable keeps its rounding or spread while the jaw opens it only a little. The jaw part of each shape: "ah" 78% of its lip gap, "eh" 56%, "oh" 38%, "ee" and "oo" ≈ 0. |
| **Switches to compare on the same page** | `LipSync.tsx` | `?lipsyncOff=jawSplit`, `placePhrases`, `phonemes`, … (any `LIPSYNC_PARTS`). `?lipsync=v1` now also turns off phonemes, the dB snapping and the split. |

ElevenLabs normalises its levels: a Tired line is only 1–3 dB quieter than a Happy one, and voices differ by about 5 dB. So "quiet words stay subtle" is measured within each line, against the loudest moment nearby, not on absolute loudness.

## Measured

**Offline bench** (41 lines, `bench.py`):

| | Releases >100 ms late | Worst 10% of releases | Seals | Vowel opening (median) | Vowels in a short gap between closures |
|---|---|---|---|---|---|
| Letter rules | 24 | 151 ms | 224/259 | 5.0 mm | — |
| + phonemes | 24 | 151 ms | 231/259 | 4.9 mm | 6.0 mm (3 of 42 shut) |
| + dB snapping | 19 | 136 ms | 232/259 | — | — |
| + jaw split | 19 | 135 ms | 232/259 | 5.4 mm | 6.0 mm (4 of 42 shut) |

The jaw split leaves lip speed and acceleration unchanged.

**Same lines in browsers** (local production build):

| Path | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Production, Chrome | 6 | -45 (p90 \|55\|) | -42 (p90 \|153\|) | -76 (p90 \|149\|) | -147 (p90 \|266\|) | -19 (p90 \|59\|) | -106 (p90 \|117\|) | 72/76 |
| Step 2, Chrome | 6 | +5 (p90 \|10\|) | +8 (p90 \|140\|) | -49 (p90 \|145\|) | -109 (p90 \|232\|) | -10 (p90 \|44\|) | -49 (p90 \|116\|) | 69/76 |
| Step 3, Chrome | 6 | +10 (p90 \|35\|) | +3 (p90 \|134\|) | -38 (p90 \|143\|) | -115 (p90 \|210\|) | -19 (p90 \|49\|) | +9 (p90 \|126\|) | 71/76 |
| Production, Firefox | 6 | -42 (p90 \|52\|) | -37 (p90 \|150\|) | -81 (p90 \|149\|) | -143 (p90 \|245\|) | -15 (p90 \|57\|) | -51 (p90 \|119\|) | 71/76 |
| Step 2, Firefox | 6 | +5 (p90 \|8\|) | +7 (p90 \|145\|) | -39 (p90 \|145\|) | -110 (p90 \|266\|) | -12 (p90 \|50\|) | -13 (p90 \|112\|) | 69/76 |
| Step 3, Firefox | 6 | +5 (p90 \|38\|) | +5 (p90 \|135\|) | -40 (p90 \|144\|) | -115 (p90 \|208\|) | -18 (p90 \|48\|) | +20 (p90 \|116\|) | 70/76 |

Timing holds from Step 2 (releases +3 to +5 ms, seals about −40 ms, one or two more lines sealed).

**Watch:** the all-rounded line ("Who knew, Lou? … too soon") reads +60 ms on the whole-line match in Chrome (Step 2: +10). Its per-vowel offsets scatter ±50 ms in every version, production included: "widest opening" is a weak measure for "oo", which is a narrow opening by design. Likely cause: with phonemes, "who" is one long "oo" from the start of the word. To judge by eye, compare the same line with `?lipsyncOff=phonemes`.

## Shapes and emotions (renders)

- **Contact sheet:** `qa/lipsync/out/shapes/current.jpg`. Every shape (rest, p/b/m, rounded p/b/m, f/v, th, t/d/n/l, s/z, ah, eh, ee, oh, oo/w) on the default face and two random light-skinned characters, front, ¾ and profile. Made with `node shapes.mjs` and `uv run sheet.py`.
- **Emotions:** `qa/lipsync/out/shapes/emotions.jpg` shows Happy and Sad as while speaking (the emotion's mouth part stepped back, as the app does). Every shape stays intact, p/b/m still seal, and the smile or frown only tints the corners. No clash found.

**Candidates for re-tuning, for your call:**
1. **"oo/w":** a narrow slit with the lower lip turned out, rather than a small round opening. It's forward in profile.
2. **"f/v":** the lower lip only lightly touches the upper teeth from the front.
3. **"t d n l":** no tongue visible. A separate "l" with the tongue tip showing behind the upper teeth isn't there yet.
4. **"ee" and "s/z"** look alike (natural, but could be told apart).

Each shape is re-solved from the GNM mouth model, so I'll only change the ones you name.


## Step 3, part 2: shapes re-tuned

Done by eye, as you asked, with a fresh solver (`pipeline/src/ftv_pipeline/viseme_solve.py`, `uv run solve-visemes`). GNM is linear, so every mouth measure in mm is exact, and a shape can be moved toward goals while every other measure holds:
- lip gap at the middle and 8 and 12 mm out (round vs slit), width, corners, protrusion;
- teeth showing, the jaw, the lower lip on the upper teeth;
- the tongue tip against the upper incisors (vertex 14860, which the tongue components move).

The lopsided components (002, 007, 012) are never used.

| Shape | Before → after (mm) | Chosen from |
|---|---|---|
| **oo / w** | gap 4.2 → 5.6, 8 mm out 1.8 → 3.6: a small round opening, not a slit; lips forward 5 mm as before | `u_round` (vs `u_rounder`, which read as "oh") |
| **f / v** | upper teeth showing 1.5 → 2.8; the lower lip tucked under them | `ff_teeth` (vs `ff_tuck`) |
| **s / z** | width +2.6 → +1.2, teeth 1.7 → 1.0 apart: told apart from "ee" | `ss_close` |
| **ee** | width +5.8 → +7.5, gap 3.7 → 4.5, corners +1.5 → +1.8 | `i_spread` |
| **l** (new) | tongue tip at the edge of the upper teeth, where it shows; "t d n" keep theirs on the ridge behind (hidden, as in life) | `ll_low` (vs `ll_edge`) |

**How "l" works:** visemes.json `ll` is a tongue pose only. An "l" (its phoneme L, or the letter rules' "l") is flagged `lateral`, and the tongue blends from the "d" pose to it (`lateralAt`, `mouth.ts`) while the lips and jaw stay the "d"'s. `?lipsyncOff=lateral` turns it off.

**Renders:**
- `qa/lipsync/out/shapes/cands.jpg`: every candidate next to the current shape.
- `qa/lipsync/out/shapes/final.jpg`: all 13 shapes on 3 faces, front, ¾ and profile.

**Per-face limits** (`caps.mjs`, 20 random characters each; different random faces per run):

| Shape | Branch | Live site |
|---|---|---|
| ah | limited on 2 faces | 6 |
| oh | 2 | 4 |
| oo | 1 | 0 |
| p/b/m | 2 | 1 |
| everything else, "l" included | 0 | 0 |

The one face that limited "oo" (to 0.16) also limited "oh" to 0.15: an extreme face where any rounding crosses geometry.

**Timing with the new shapes** (Chrome, the same 6 lines):

| | Whole-line lag | Lips part vs burst | Seal | Vowel peaks | f/v | Sealed |
|---|---|---|---|---|---|---|
| Production | −45 | −42 | −76 | −19 | −106 | 72/76 |
| Step 2 | +5 | +8 | −49 | −10 | −49 | 69/76 |
| **Step 3 + shapes** | **+10** | **+2** | **−40** | **−20** | **+2** | **71/76** |

On the bench, lip speed and acceleration are unchanged (p99 137 mm/s, p95 3.8 m/s²). The rounded line's whole-line lag is back down to 22 ms (it was 60 before the shape and gate changes).


---

# Step 4: live conversations

## What changed

| Change | Where | Why |
|---|---|---|
| **Same clock and pipeline as Speak** | `live.ts` (`HeardClock`), `cues.ts` | Live replies already went through `alignmentToCues`; they now also use the heard clock, the jaw/lip split, the "l" tongue and the phrase placing (`phrasesPlaced`). |
| **Phonemes for live words** | `/api/phonemes` (new), `phonemes.ts` `queuePhonemes`, `live.ts` `addWords` | The agent sends only words, so the page asks the server for their phonemes. A reply's words are gathered for 150 ms and sent in one request (up to 60 words). Words arrive ahead of the sound, so the cues are rebuilt before they are heard. The route answers only plain lower-case words, at most 80 per request, cached for good. |
| **Batching fixed a real failure** | `phonemes.ts` | The first version asked once per word: a chat on the preview hit the site's `/api` rate limit (429) within a reply, and the words fell back to the letter rules. One request per reply stays far below the limit. |

**Tried and dropped:** shaping the mouth from the agent's own loudness ("sent", which arrives well ahead of the sound)
instead of the page's meter, so the closure and vowel snapping could see further ahead. On the live bench it changed
nothing (releases −14 both ways, seals −51 both ways, vowels −20 vs −24, one more late release). The meter's 130 ms
look-ahead is already enough for the phrase placing, which is what live replies need: the agent's word times are
off by up to 300 ms per phrase. The code is removed.

## Measured

**Real chats on the preview** (Chrome, character A, a greeting + 3 turns each; the replies are different words each
time, so the rows compare the same kind of speech, not the same lines). Both rows are measured the same way (pixels where the lips stayed in
the crop, the app's per-frame values for the chats where the head left it; see the correction under Step 1):

| | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Production | 4 | -70 (p90 \|80\|) | -19 (p90 \|150\|) | -115 (p90 \|145\|) | -174 (p90 \|342\|) | +5 (p90 \|58\|) | -78 (p90 \|112\|) | 22/26 |
| **Step 4** | 4 | **-10** (p90 \|21\|) | **+14** (p90 \|129\|) | **-54** (p90 \|134\|) | -146 (p90 \|292\|) | -12 (p90 \|49\|) | **-9** (p90 \|86\|) | 18/20 |

The one chat whose lips stayed in the crop throughout (the greeting) gives, by pixels: lag −10, releases +15,
seal −84, 5/5 sealed.

**Offline live bench** (`live-bench.sh`, the 3 recorded replies through the real `LiveSpeech` and mouth):
releases −14 (p90 131, 3 over 100 ms late), seals −51, closing −157, vowels −20 (p90 54), f/v −8, 14/14 sealed.
Script time 21–35 µs per frame.

## Still open

- **Live closures still close early** (seal −54, closing −146): the agent's word times are coarse, and the phrase
  placing can only move whole phrases. Releases are on time.
- **Firefox and Safari live** are not re-measured: the day's chat limit was nearly used. They share the clock and
  pipeline, and Speak shows no browser differences after Step 2.
- **The recorder now follows the lips** (it looks for them every 0.5 s and moves the crop), and `mouth.py` marks
  frames whose lips are out of the crop (frames grouped by the head's position, each group judged by its median lip
  height); `events.py` leaves those out. The new live runs in Step 5 can
  then be measured by pixels.

## Step 4 follow-up: back-to-back p/b/m, tools for Step 5

**"Bob bought" closed twice.** Two p/b/m with no vowel between them ("Bob bought", "I'm managing", "mum made") are one
closure in the audio: the lips close once for both. The snapping gave every p/b/m a quiet stretch of its own, so the
second found nothing near and stayed on its stamp, often in the next vowel: the lips closed again on "ought" and the
word was never mouthed. Now the second takes the first's closure (`LIPSYNC_PARTS.joinClosures`, `?lipsyncOff=joinClosures`
to compare). Where the first had itself landed in the wrong place (a pause before "I'm", the "d" of "made"), only a
closure between the vowel before the first and the vowel after the second counts, and two halves of one quiet stretch
are joined into the whole.

| | Late releases (>100 ms) | Worst 10% of releases | Sealed | Vowels |
|---|---|---|---|---|
| Bench, 41 lines, before | 17 | 135 ms | 224/237 | −19 |
| Bench, 41 lines, after | 16 | 131 ms | 223/237 | −19 |
| Chrome, 5 lines with back-to-back p/b/m, before | — | 132 ms | 69/77 | −22 |
| Chrome, same lines, after | — | 115 ms | 69/77 | −17 |

"bought" now parts on its burst: +158 → +8 ms and +154 → +5 ms in Chrome (A's and B's voices). The bench now counts
closures that overlap in the audio as one (the aligner gives each word its own), so its totals differ from Step 3's.
Before/after clip: `qa/lipsync/out/compare/bob-bought-join-slow.mp4` (left: before, the lips stay shut through
"ought"; right: after).

**Tried and dropped:** on a slow network (audio arriving at 0.85× real time), p/b/m part 30–80 ms late (median per line) and
some 150 ms, because each closure plays before the audio after it has arrived, on its stamps. Waiting for 0.45 s of
audio after each stall before going on didn't change it (+61/+43 vs +55/+30 ms, the same words late): at 0.85× the
buffer drains again within a few seconds. Left open: it only happens when the sound itself is stalling.

**Step 5 tools:** `rerun.sh` re-records every production replay on a new deploy, `summary.py --compare rp <tag>`
prints the before/after table, `sidebyside.py` makes the slow-motion clips (see the README).

## Voices that deliver differently (2026-10-14)

Four new characters, light-skinned, picked for contrast before any voice was made (`speak.mjs --age … --lookOnly`),
each speaking 6 lines with an expression that pulls its delivery: D1 an old man (Tired), D2 a woman (Sad), E1 a young
woman (Surprised), E2 a young man (Happy). With A, B and C from Step 1 (`voices.py`, offline bench, current code):

| Voice | Lines | Syllables/s | Pauses per 10 s | Median pause | Loudness spread (stress) | p/b/m release | Late (>100 ms) | Sealed | Vowels |
|---|---|---|---|---|---|---|---|---|---|
| A (default face) | 16 | 3.8 | 2.5 | 340 ms | 15.3 dB | −3 | 8 | 87/94 | −21 |
| B | 10 | 3.8 | 2.4 | 305 ms | 10.3 dB | −5 | 3 | 49/54 | −21 |
| C | 15 | 3.1 | 2.1 | 280 ms | 11.9 dB | −7 | 4 | 87/89 | −16 |
| D1 old, Tired | 6 | 3.4 | 4.3 | 390 ms | 14.9 dB | +6 | 3 | 41/42 | −19 |
| D2 Sad | 6 | 3.0 | 4.1 | 295 ms | 11.9 dB | −5 | 2 | 39/42 | −22 |
| E1 young, Surprised | 6 | 3.6 | 1.1 | 270 ms | 11.0 dB | −2 | 6 | 37/42 | −13 |
| E2 young, Happy | 6 | 3.7 | 4.0 | 310 ms | 12.7 dB | +2 | 5 | 41/41 | −29 |

(Two "late" per voice are quirks of the measure, in every voice: "mm" is a hum with closed lips, "stop!" ends in
silence.)

- **The medians hold for every voice:** p/b/m part within −7..+6 ms of the burst whatever the pace, pausing or stress.
- **The tail depends on the voice.** The young, quick voices had the most late releases. In E2's tongue-twister the
  second "p" of "peppers" was stamped 140 ms late, and the closure search only looked 120 ms before a stamp. It now
  looks 200 ms before (`LIPSYNC.snapBefore` 0.12 → 0.2): six closures better across the 65 lines, none worse.
- **In Chrome** (the app's own per-frame values; D1/D2's heads turned and E1's lips were too pale for the pixel
  measure), the four new voices before → after today's two changes (back-to-back p/b/m, wider search): late releases
  20 → 12, worst 10% 152 → 137 ms, medians unchanged (release +8 → +9, vowels −19 → −18).
- **Still open:** E1 has the most late releases (6 of 40), and D1's lips part about 25 ms late throughout (its tired,
  breathy p/b/m have soft bursts).

The site's Speak limit is 100 per visitor in a sliding 24 hours, shared by the previews and the live site: this pass
used it up for the day (the last cached replay got a 429).

## Live in Firefox (2026-10-14)

A chat on the preview (Step 4 code; character A, greeting + 3 turns), measured by pixels: the recorder now follows the
lips, and only 28 frames of one reply left the crop.

| | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Production | 4 | -58 (p90 \|64\|) | -43 (p90 \|159\|) | -112 (p90 \|150\|) | -161 (p90 \|273\|) | -4 (p90 \|59\|) | -25 (p90 \|116\|) | 23/24 |
| **Step 4** | 4 | **-5** (p90 \|17\|) | **-5** (p90 \|152\|) | -86 (p90 \|147\|) | -160 (p90 \|254\|) | -7 (p90 \|54\|) | +13 (p90 \|112\|) | 24/25 |

Firefox now matches Chrome: the mouth is on the voice, and p/b/m part on the burst. Live closures still close early
(−86 here, −54 in Chrome).

**Safari** (the same day, after the push: the preview has the back-to-back p/b/m join and the wider search; pixels,
no frames out of the crop). Production had only one Safari reply, so its row is thin:

| | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Production | 1 | -65 (p90 \|65\|) | +62 (p90 \|136\|) | -116 (p90 \|137\|) | -208 (p90 \|367\|) | +0 (p90 \|46\|) | -64 (p90 \|64\|) | 4/5 |
| **Branch** | 4 | **-12** (p90 \|26\|) | **+18** (p90 \|125\|) | -84 (p90 \|142\|) | -167 (p90 \|322\|) | -14 (p90 \|54\|) | -103 (p90 \|116\|) | **25/25** |

Open: f/v in Safari live reaches the teeth early (−103; Chrome −9, Firefox +13).

Getting Safari to chat took three tool fixes: its driver can't run a script before the page's own, so a restored
session arrived after the app had read an empty one (the adapter now loads the page a second time the first time);
the script must never press Find my voice for a restored character (that spends a voice design, shared with the live
site); and it now clicks the Meet card's button, not the "Meet" step, once the card is there. With the Mac's display
asleep Safari reports the page as hidden and draws nothing, so the head never loads.

## The three small open items, checked (2026-10-14)

All three were measured before changing anything; none called for an app change.

- **f/v early in Safari live (−103): the words, not Safari.** Safari's replies happened to say "office" and "coffee"
  twice each (about −110 apiece); Firefox's "coffee" came out +63 and +71. Replayed offline with a perfect clock, the
  same replies give −47 (Safari's) and +28 (Firefox's). Across all 11 live replies the f/v median is −1 ms, with about
  ±110 ms of scatter in every browser. Giving the live meter more look-ahead (holding the voice back 0.3 or 0.5 s
  instead of 0.13, `live-bench.sh --delay`) doesn't help f/v (+12, +9). It would put p/b/m on the burst (releases
  −29 → −2) but with more very late ones (worst 10%: 140 → 158 ms), and every reply would start 170–370 ms later.
  Kept at 0.13.
- **D1 (old, Tired) parting late (+21 in Chrome by pixels): within the noise.** Offline its median is +6 with a wide
  spread (middle half −9..+26 ms); the other new voices are +4..+13 in Chrome. With 40 closures, a 10 ms difference
  between voices isn't a shift.
- **E1's late tail: its stamps.** In "summer" the whole word is stamped about 100 ms late. The real "m" is within the
  search, but a shallow dip next to the late stamp scores better. A gentler distance penalty (`snapDbPerS` 150 → 100
  or 75) fixes some closures and breaks as many ("picked" fixed, "breakfast" broken): late releases 31 → 32–33 and the
  worst 10% 136 → 147–151 ms across the 65 lines. Kept at 150.

