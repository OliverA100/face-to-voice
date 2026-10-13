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
| `node chat.mjs --url <deployment> --char A [--restore A] [--turns 3] [--browser b]` | A live chat. The visitor is `out/visitor/*.wav` (macOS `say`); each reply is one run | Chat minutes |
| `node room.mjs --browser b cal` / `replay clip…` | The screen + Mac mic (`screencapture`); needs Screen Recording permission | free |
| `node cal.mjs b raw` | The in-page recorder's self-check on `calibrate.html` | free |
| `node perf.mjs [--cpu 4] clip.ndjson` | Frame rate and script time per frame, phone screen, slowed CPU | free |

**Find my voice counts against your IP's daily limit** (20), even for cached voices. Reuse saved characters with
`--restore <char>` (sessions are saved in `out/chars/`) instead of making new ones.

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

Negative offsets = the mouth is early. "Heard time" means the moment the browser says a sample reaches the
speakers; the room and phone tools check that against reality.

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
