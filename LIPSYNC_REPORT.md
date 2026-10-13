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

| Path | Runs | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Closing starts | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|---|
| Speak, first-time (streamed), Chrome | 41 | -60 (p90 \|75\|) | -18 (p90 \|154\|) | -98 (p90 \|147\|) | -150 (p90 \|293\|) | -6 (p90 \|58\|) | -61 (p90 \|118\|) | 233/259 |
| Speak, cached, Chrome | 10 | -55 (p90 \|60\|) | -32 (p90 \|154\|) | -95 (p90 \|147\|) | -155 (p90 \|255\|) | -4 (p90 \|59\|) | -31 (p90 \|118\|) | 52/55 |
| Speak, cached, Firefox | 5 | -25 (p90 \|33\|) | -13 (p90 \|153\|) | -71 (p90 \|149\|) | -134 (p90 \|228\|) | -17 (p90 \|53\|) | -14 (p90 \|113\|) | 40/43 |
| Speak, cached, Safari | 5 | -35 (p90 \|43\|) | -20 (p90 \|157\|) | -81 (p90 \|146\|) | -144 (p90 \|333\|) | -12 (p90 \|52\|) | -22 (p90 \|113\|) | 39/43 |
| Real lines replayed, streamed pace, Chrome | 6 | -50 (p90 \|60\|) | -47 (p90 \|153\|) | -80 (p90 \|148\|) | -150 (p90 \|271\|) | -14 (p90 \|60\|) | -47 (p90 \|118\|) | 72/76 |
| Real lines replayed, Firefox | 12 | -25 (p90 \|34\|) | -18 (p90 \|152\|) | -67 (p90 \|147\|) | -130 (p90 \|258\|) | -19 (p90 \|57\|) | -64 (p90 \|119\|) | 133/145 |
| Real lines replayed, Safari | 5 | -35 (p90 \|48\|) | -22 (p90 \|152\|) | -64 (p90 \|146\|) | -143 (p90 \|302\|) | -11 (p90 \|55\|) | -47 (p90 \|117\|) | 62/66 |
| Slow network (underruns), Chrome | 2 | -48 (p90 \|50\|) | -22 (p90 \|154\|) | -143 (p90 \|148\|) | -187 (p90 \|300\|) | +3 (p90 \|53\|) | +6 (p90 \|119\|) | 26/27 |
| Live chat, Chrome | 4 | -52 (p90 \|72\|) | -9 (p90 \|153\|) | -94 (p90 \|149\|) | -160 (p90 \|320\|) | +5 (p90 \|53\|) | +1 (p90 \|93\|) | 22/26 |
| Live chat, Firefox | 4 | -35 (p90 \|42\|) | -5 (p90 \|153\|) | -103 (p90 \|147\|) | -155 (p90 \|242\|) | -22 (p90 \|55\|) | -58 (p90 \|119\|) | 23/26 |
| Live chat, Safari | 1 | -45 | +80 (p90 \|142\|) | -107 (p90 \|138\|) | -191 (p90 \|373\|) | +1 (p90 \|47\|) | -110 | 4/5 |

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
