# Lip-sync measurement tools

These tools measure how well the mouth matches the voice on a real deployment, in real browsers and devices. Results
for the current state are in `../../LIPSYNC_REPORT.md`. Recordings go to `out/` (gitignored, several GB).

## Setup (once)

```bash
cd qa/lipsync && pnpm install
```

- Python scripts run with `uv run …` (dependencies are inline).
- `truth.py` downloads the wav2vec2 aligner (~360 MB) into `out/.torch` on its first run.
- Browsers:
  - Chrome and Firefox are driven by puppeteer-core with the system apps.
  - Safari is driven by safaridriver. In Safari: Settings → Advanced → "Show features for web developers", then Developer → "Allow remote automation".
- Optional files in `out/`:
  - `qa-token.txt`: the `QA_BYPASS_TOKEN` of a deployment that has the temporary BotID skip.
  - `vercel-bypass.txt`: Vercel's "Protection Bypass for Automation" secret, for preview deployments.
  - `preview-url.txt`: the preview's URL.
- `node serve.mjs` serves `calibrate.html` on :3199 (also on the LAN, for a phone).

## Recording

| Command | What it records | Cost |
|---|---|---|
| `node replay.mjs [--browser b] [--pace instant\|stream\|slow] clip.ndjson …` | Saved lines through the live site's own player (`?debug`) | free |
| `node speak.mjs --url <deployment> --char A [--restore A] [--random --skin fair] [--emotion -,Happy] [--lines plosive,fv] [--cached\|--cachedOnly] [--browser b]` | Real Speak presses; saves every line to `out/clips/` for replays | TTS credits; `--random` = 1 design + 1 save |
| `node chat.mjs --url <deployment> --char A [--restore A] [--turns 3] [--browser b] [--tag t]` | A live chat. The visitor is `out/visitor/*.wav` (macOS `say`); each reply is one run (`<tag>-A-chat<k>-<browser>`), with the page's reply data (words, the agent's loudness, anchors, cues) in `meta.json` "live" | Chat minutes (10 chats per visitor per day) |
| `node room.mjs --browser b cal` / `replay clip…` | The screen + Mac mic (`screencapture`); needs Screen Recording permission | free |
| `STALE_IDLE=1 STALE_TAB=1 node stale.mjs --hide 600` then `uv run calmark.py` | Safari's stuck output after an idle tab: calibrate.html left idle behind another tab, then measured in the same tab (same context, new ones, other sample rates, the `<audio>` route); `STALE_SUSPEND=1` suspends it while idle | free |
| `uv run beeps.py`, `node appstale.mjs --cal --clip out/beeps.ndjson [--url2 …]`, then `uv run appcal.py` | The same in the app: a beep track through the app's player, a patch flashing on its clock, before and after the idle (`APP_IDLER=1`: a context left running, forcing the stuck output; `APP_RELOAD=1`: then reloaded; `APP_CUT=1`: a line cut, then the next) | free |
| `node otherstale.mjs --browser chrome\|firefox` then `uv run appcal.py` | The same trigger in Chrome or Firefox (plain settings, no background-throttling switches) | free |
| `node serve.mjs`, then in the iPhone simulator `xcrun simctl openurl booted http://localhost:3199/calibrate.html`; tap Direct / Element / Idle while `screencapture -v -V 15 -g -x -R <Simulator window>` records; `uv run simcal.py out/room/<name>.mov` | The same in iOS Safari (the Simulator in front; background Safari with `xcrun simctl launch booted com.apple.Preferences`, back with `com.apple.mobilesafari`) | free |
| `node cal.mjs b raw` | The in-page recorder's self-check on `calibrate.html` | free |
| `node perf.mjs [--cpu 4] clip.ndjson` | Frame rate and script time per frame, phone screen, slowed CPU | free |

**Find my voice counts against your IP's daily limit** (20), even for cached voices. Reuse saved characters with
`--restore <char>` (sessions are saved in `out/chars/`) instead of making new ones.

**The head moves:** it pitches for seconds at a time (cursor follow, nods in a chat). The recorder looks for the lips
every 0.5 s and moves the crop when they have moved. `mouth.py` marks frames whose lips are out of the crop ("clipped": frames
are grouped by the head's outline in the whole-head grab, and each group judged by its median lip height) and
`events.py` leaves their events out ("unmeasured").
`summary.py` falls back to `events.py --app` for runs where over half the events are unmeasured.

**Characters:** dark skin hides the open mouth from the pixel measure. Make new characters with `--skin fair` or
`--skin light`, or score them with `events.py --app`.

## Analysing

```bash
./analyse.sh 'A-*'          # truth.py (audio events) + mouth.py (pixels) + events.py (offsets), skips done steps
uv run events.py --app <run> # the app's own mouth values instead of pixels (needs ?debug runs)
uv run summary.py --md       # pooled table per path × browser (LIPSYNC_REPORT.md)
uv run strips.py <run> closure|vowel|fv|word:<w> [--all]   # frame strips around events, for checking by eye
uv run room.py <room run>    # flash vs beep (cal runs) or mouth vs mic (line runs) on the capture's clock
uv run phone.py film.mov <mouth x> <mouth y> <camera delay ms> <line starts…>
```

**Before and after a deploy** (Step 5; free, same audio):

```bash
./rerun.sh "https://facetovoice.com/?debug=1" after [rp] [chrome firefox safari]   # re-records every rp-* replay
uv run summary.py --md --compare rp after       # per browser × pace: before row, after row (lines in both only)
uv run sidebyside.py rp-A-plosive-chrome-stream after-A-plosive-chrome-stream [--slow 0.25] [--view full]
```

`sidebyside.py` writes `out/compare/<name>.mp4` and `<name>-slow.mp4`: the two runs' mouth grabs side by side, lined
up on the voice onset, with the line's audio (slowed with its pitch kept).

Negative offsets = the mouth is early. "Heard time" means the moment the browser says a sample reaches the
speakers; the room and phone tools check that against reality.

## Offline bench (no browser)

```bash
uv run truth.py out/clips/*.ndjson                       # once per saved line: its audio truth on the line's own clock
./bench.sh --tag try --set lead=0.03,phraseSlack=0.03 [--off placePhrases] out/clips/*.ndjson
uv run bench.py base try [-v]                            # pooled offsets, late releases, lip speed/acceleration
```

`bench.py` counts closures that overlap in the audio as one ("Bob bought": the aligner gives each word its own, but
the lips close once). `bench.sh` runs the app's own `web/src/lib/lipsync` code (`mouth.ts`, the evaluator) on saved lines at 120 fps, on a
perfect clock, and records the lips' and jaw's opening in mm. `--set` overrides `LIPSYNC` constants and `--off`
switches `LIPSYNC_PARTS` off. Browsers add about 12 ms of drawing delay to what the bench shows.

**Live replies:**

```bash
./live-bench.sh --tag try [--set k=v] [--off part] L2-A-chat0-chrome L2-A-chat1-chrome   # recorded chat.mjs runs
uv run bench.py base try
```

`live-bench.sh` replays a recorded reply as a chat delivers it: the words and the agent's loudness up front, the
meter's 10 ms blocks from the heard audio `LIVE.delay` ahead, and the AudioContext clock stepping per frame, through
the real `LiveSpeech` and mouth. It needs a run's `truth.json` and `meta.json` "live" (chat.mjs from Step 4 on).

**Sets, and real lips as the target:**

```bash
uv run board.py base try                                 # every set apart: tune on T* only, the rest are checks
uv run human.py try ['^T\d']                             # the app against real talkers (GRID), measured the same way
uv run word.py try T1-t031-neutral point                 # one word: the sound's events, the cues, when the lips were shut
```

Lines are filed by the clip's first letter: `T` tuning (Harvard sentences 5–34), `S` held out (Harvard 1–4, CMU
ARCTIC), `U`/`W` more ARCTIC, `V` this project's own conversation lines (`sets/conversation.json`), `A`–`E` the
original stress lines. The Harvard and ARCTIC texts stay out of the repo (`out/sets/`); `speak.mjs --set` records a
set's lines in the studio voices against a local server (`FTV_MOCK_ELEVENLABS=1 FTV_SAVED_VOICES=1`).

`grid.py` measures real lips in the GRID audio-visual corpus (Cooke et al. 2006, CC BY 4.0, zenodo.org/records/3625687:
the talkers' video zips unpacked to `out/grid/<talker>/`, `alignments.zip` to `out/grid/align/`): MediaPipe's face mesh on each 25 fps video,
the sound from its own audio track, per p/b/m when the lips start closing, shut and part, per f/v and vowel when they
reach the teeth or are widest. `uv run grid.py out/grid/s1` → `out/grid/s1.jsonl`; `uv run grid.py --summary
out/grid/*.jsonl`. `human.py` reads those files and applies the same "shut" rule (15% of the line's lip range) to the
bench, split by what comes before the p/b/m (a vowel, or silence).

**How far the mouth moves, against real talkers:**

```bash
uv run gridframes.py out/grid/s1                         # once per GRID talker: per-frame lips → out/grid/frames/s1.jsonl
uv run appframes.py out/runs/<run> …                     # the app's recorded face (full thumbnails), the same measure
uv run shapes_vs_real.py --mp "<tag>-S*"                 # opening and width per vowel class, app vs real talkers
uv run shapes_vs_real.py <bench tag>                     # the same from a bench run (needs out/shape_coefs.json)
```

Both sides go through MediaPipe's face mesh (inner-lip gap, mouth width over the outer-eye-corner distance, put in mm
with the app's 88 mm); on the app's renders it reads the lips within ~1 mm of their real opening (r 0.98). The opening
counts from each sentence's most closed moment, and only inside words. `out/shape_coefs.json` comes from the pipeline
rig's `shape_coefs.py` (mm per unit of each morph target).

## Shapes contact sheet

```bash
node shapes.mjs --url http://localhost:3041/ --faces 3 --tag current [--emotion Happy]
uv run sheet.py out/shapes/current                        # → out/shapes/current.jpg
```

Each viseme preset is held still (the debug handle's "viseme" layer, capped for the face) and rendered from the front,
¾ and profile. Faces after the first are random characters given a light skin tone.

## Re-tuning a shape

```bash
cd pipeline && uv run solve-visemes measure                # every shape's mouth measures (mm)
uv run solve-visemes solve                                  # candidates for GOALS → pipeline/out/visemes/cands.json
cd ../qa/lipsync && node shapes.mjs --presets ../../pipeline/out/visemes/cands.json --keys u_now,u_round --tag cands
uv run sheet.py out/shapes/cands                            # pick by eye, then:
cd ../../pipeline && uv run solve-visemes apply u=u_round   # writes visemes.json and its "speed"
cd ../qa/lipsync && node caps.mjs --url http://localhost:3041/ && node caps.mjs --url https://facetovoice.com/
```

## Phone and Bluetooth recipes

- **AirPods:**
  - Turn Automatic Ear Detection off.
  - Sound input = MacBook Pro Microphone; output = the AirPods at full volume.
  - Press one bud's mesh onto the Mac's mic holes (top left, near Esc).
  - Run `room.mjs --tag bt …`.
- **iPhone:**
  - QuickTime → New Movie Recording (MacBook camera + mic).
  - Clap once in view of the camera (that gives the camera's delay), then play lines on the phone.
  - For the device delay, open `http://<mac LAN ip>:3199/calibrate.html` on the phone and film about 15 flashes.
  - Analyse with `phone.py`, or with the snippets in LIPSYNC_REPORT.md.
