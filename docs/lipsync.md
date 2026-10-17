# Lip sync: method and measurements

How well the mouth matches the voice, how that was measured, and what is still open. How the lip sync works is in
[ARCHITECTURE.md](ARCHITECTURE.md#voice-and-lip-sync); every tuning value, with the reason for it, is in
`web/src/lib/lipsync/tuning.ts`; the tools are in [`qa/lipsync`](../qa/lipsync/README.md).

**Sign convention:** negative = the mouth is early, positive = the mouth is late. All times are in ms.

## Where it stands

- **The mouth is on the voice.** Over a whole line it is within ±15 ms of the sound in Chrome, Firefox and Safari,
  for first-time (streamed) and cached lines alike.
- **p/b/m close and part like real lips.** Measured against real talkers in the GRID audio-visual corpus with the same
  rule, the app's lips start closing, shut and part within a few ms of theirs after a vowel (table below).
- **Words are mouthed where they are said.** Each new line is timed by ElevenLabs Forced Alignment on its own audio
  before it plays, so a word's sounds aren't left where the speech model's stamps put them (up to ~0.2 s off).
- **Live chats use the same mouth.** Their word timings come from the agent ahead of the audio; the voice is held back
  130 ms so the lip sync sees each sound before it is heard.
- **It is cheap:** about 0.4 ms of script per frame on a phone profile (CPU slowed 4×), with no dropped frames.

## How it is measured

Every measurement compares the mouth with the audio that was actually played, never with the app's own idea of
either. The tools drive real browsers through the site's own buttons.

| Piece | What it does |
|---|---|
| `inject.js` | In-page recorder: taps every node connected to the speakers, so it records exactly what the page plays, and grabs the canvas after each render. Both are stamped on the page's AudioContext clock. |
| `speak.mjs`, `chat.mjs`, `replay.mjs`, `safari.mjs` | Drive Chrome and Firefox (puppeteer-core) and Safari (WebDriver). `replay.mjs` plays saved lines again, so before/after comparisons use identical audio. |
| `truth.py` | The audio's ground truth with no app code: a wav2vec2 forced aligner plus acoustic landmarks (closure onset and burst for p/b/m, hiss onset for f/v/th, loudness peak for vowels). |
| `mouth.py`, `events.py` | The mouth's opening per frame, paired with each audio event. |
| `room.mjs`, `room.py`, `calibrate.html` | What a person sees and hears: the screen and the Mac's microphone on one clock, and a flash-and-beep page that measures each device's real output delay. |
| `bench.sh`, `live-bench.sh` | The app's exact mouth code on every saved line, with no browser: hundreds of lines in seconds. |
| `grid.py`, `human.py` | Real lips from the GRID corpus (Cooke et al. 2006, CC BY 4.0) via MediaPipe's face mesh, and the app's lips by the same rule. |

**Checks on the tools:**
- The recorder matched every frame to its timestamp within one frame in Chrome, Firefox and Safari.
- The mouth read from pixels and the app's own per-frame values agree within 10–20 ms.
- Room capture uses macOS `screencapture`; ffmpeg's avfoundation input dropped about 14% of mic samples under load.

**The pixel measure's limit:** `mouth.py` finds the open mouth by its contrast with the lips, so it is unreliable on
darker skin tones and in bright, low-contrast films. Those runs use the app's own per-frame values instead
(`events.py --app`), which work for every face.

**Lines:** 300 Harvard sentences for tuning, and only for tuning; 141 held-out sentences (Harvard 1–4 and CMU ARCTIC),
60 conversational lines (`qa/lipsync/sets/conversation.json`) and 65 stress lines (tongue twisters, m-heavy lines) for
checking. Voices of different ages, paces and expressions, so a setting that only suits one delivery shows up.

## Devices: what is heard when

Each browser reports how late its sound is heard. The flash-and-beep page draws a flash when the browser thinks the
beep is heard; the microphone shows when it really is (± one 60 Hz frame).

| Output | Browser | Reported delay | Flash vs beep heard | Real delay (about) |
|---|---|---|---|---|
| MacBook speakers | Chrome | 24 | −7 | 30 |
| MacBook speakers | Firefox | 22 | +3 | 20 |
| MacBook speakers | Safari | 16 | −20 | 35 |
| AirPods (Bluetooth) | Chrome | 168 | −75 | 245 |
| AirPods (Bluetooth) | Safari | 160 | −88 | 250 |
| iPhone speaker (filmed, ±20) | iOS Safari | 12 | +50 | about 50 less than reported |

So the browsers' own figure is right within about 20 ms on built-in speakers, under-reports Bluetooth by about 80 ms,
and over-reports on an iPhone by about 50 ms. `clock.ts` corrects the last two (`BLUETOOTH`, `IOS_EXTRA`), carries time
between Chrome's 10.7 ms clock steps, and reads the clock once per frame. The Sync setting covers whatever is left on a
particular device.

## Results

### Before and after, on the deployed site

The same 25 saved lines in the same browsers, before the timing work and after it (in-page, pooled; median, with the
p90 of the distance in brackets):

| Browser, delivery | | Whole-line lag | p/b/m lips part vs burst | p/b/m seal vs sound stops | Widest vowel vs loudest | f/v lip-teeth vs hiss | Sealed |
|---|---|---|---|---|---|---|---|
| Chrome, streamed | before | −45 (55) | −42 (153) | −76 (149) | −19 (59) | −106 (117) | 72/76 |
| | **after** | **+12 (22)** | **+2 (99)** | −44 (146) | −15 (47) | **−3 (119)** | 72/76 |
| Firefox, streamed | before | −48 (55) | −35 (154) | −84 (149) | −17 (56) | −105 (118) | 61/69 |
| | **after** | **+5 (15)** | **+5 (113)** | −42 (145) | −19 (47) | **−17 (120)** | 68/72 |
| Safari, streamed | before | −52 (62) | −39 (125) | −76 (147) | −6 (56) | −93 (118) | 45/49 |
| | **after** | **+5 (19)** | **+7 (86)** | −40 (140) | −18 (45) | **+4 (116)** | 45/49 |

The main cause before was a fixed 80 ms head start applied to the whole mouth, releases included. It is now 30 ms, and
the anticipation lives where real lips anticipate: in closing toward a p/b/m and in rounding.

### Against real talkers

GRID's talkers, about 2,000 p/b/m, measured by the same rule as the app ("shut" = within 15% of the line's lip range
above its smallest). Held-out sets only, nothing here was tuned on:

| | Closing starts | Shut | Part | f/v to the teeth | Widest vowel |
|---|---|---|---|---|---|
| Real talkers, after a vowel | −90 | −6 | +24 | +74 | +27 |
| **App, after a vowel** | **−89** | **−5** | **+26** | +55 | +7 |
| Real talkers, after silence | −156 | −41 | +21 | | |
| **App, after silence** | −108 | −29 | **+25** | | |

By this rule real lips "part" about 24 ms after the burst: they open gradually, and the burst comes as they first
separate. Sealed p/b/m on the held-out sets: 89 of 93 (Harvard and ARCTIC), 174 of 186 (conversation).

### Forced alignment

v4 Turbo's character stamps spread a word's letters evenly across it, so a vowel or a word-initial consonant can be
stamped well away from its sound. Aligning each line on its own audio (`lib/server/alignSpeech.ts`), on the 300
tuning lines:
- vowel cues outside the word they belong to: 7–12% → 0–2%;
- p/b/m releases over 100 ms late: 31 → 18, and over 100 ms early: 15 → 4.

Each of the 300 lines was then reviewed by eye, frame by frame, until every one passed. A new line waits for its
alignment (about 0.2–0.35 s, plus reading the whole line) before it plays; the aligned line is cached with its audio,
so a replay starts at once. If alignment fails, the speech model's own stamps are used.

### Live chats

Measured on recorded chats in Chrome, Firefox and Safari: whole-line lag −5 to −12 ms, lips part −5 to +18 ms.
Live replies have no forced alignment; their words are pinned to where the voice starts, and kept on it by matching
what the browser hears against the agent's own loudness.

## Tried and not kept

- **Faster lip limits** (higher speed and acceleration) to mouth short words between closures: no gain. Counting a
  pause as a syllable between two closures, and dictionary phonemes, fixed those instead.
- **A longer live look-ahead** (holding the voice back 0.3 or 0.5 s instead of 0.13): p/b/m slightly closer to the
  burst but more very late ones, and every reply 170–370 ms slower to start.
- **Reading live p/b/m and vowels off the agent's own loudness** (which arrives earlier) instead of the heard audio:
  no gain on the bench.
- **Waiting for more audio after a network stall:** at 0.85× delivery the buffer drains again within seconds.
- **A gentler distance penalty for closure snapping:** fixed as many closures as it broke.
- **Aligning vowels only, or adding t/d/k/g as alignment events:** more late releases than aligning p/b/m and vowels
  together.

## Known limits

- **Outliers:** on the tuning set about 9% of releases are over 100 ms late and 3% early (real talkers: 6% and 0.8%).
  Those checked against the waveform are mostly wrong ground truth or word-final p's with no real burst ("sharp").
- **Vowels peak early:** the widest point is about 20 ms before real lips'. Reading the loudness further behind
  moves it later but holds f/v open.
- **After silence** the lips start closing later than a real talker's, who gets ready before speaking.
- **Live closures** shut earlier than recorded lines' (about −50 to −90 ms before the sound stops): the agent's word
  times are coarser.
- **A stalling network:** when the sound itself stalls mid-line, p/b/m can part 30–80 ms late.
- **Not measured:** Android (no device), and the iPhone only by camera, so per-sound iPhone numbers are rough; its
  output delay is solid.

## Re-running

See [`qa/lipsync/README.md`](../qa/lipsync/README.md): record with `speak.mjs`, `chat.mjs` or `replay.mjs`, analyse
with `./analyse.sh` and `uv run summary.py --md`, compare against real talkers with `uv run human.py`. Recordings go to
`qa/lipsync/out/` (gitignored).
