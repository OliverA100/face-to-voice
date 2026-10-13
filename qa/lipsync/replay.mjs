/*
 * Plays saved NDJSON lines through the LIVE site's own speech player (needs ?debug for window.__faceToVoice) and
 * records each one. No API call, no credits: the same player, clock, mouth and renderer visitors get.
 *
 *   node replay.mjs [--browser chrome|firefox] [--url https://facetovoice.com/?debug=1] [--pace instant|stream]
 *                   [--tag name] clip.ndjson [more.ndjson ...]
 *
 * --pace slow delivers the audio at 0.85× real time, so the player runs dry mid-line (an underrun).
 * --pace stream releases the NDJSON lines on the arrival times saved with the clip (speak.json from a real first-time
 * Speak), else at 4× real time, so the player starts on a partial line like a first-time Speak does.
 */
import fs from "node:fs";
import path from "node:path";

import { headReady, launch, open, record, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const browser = opt("browser", "chrome");
const url = opt("url", "https://facetovoice.com/?debug=1");
const pace = opt("pace", "instant");
const tag = opt("tag", "");
const headless = opt("headless", "0") === "1";
const clips = args;

const br = await launch({ browser, headless });
const page = await open(br, url);
await headReady(page);
// unlock the player's audio context once (a click, as a visitor would)
await page.mouse.click(300, 300);
await page.evaluate(() => window.__faceToVoice.speech.unlock?.());
await sleep(500);

for (const clip of clips) {
  const nd = fs.readFileSync(clip, "utf8");
  const arrivals = (() => {
    const sj = clip.replace(/\.ndjson$/, ".arrivals.json");
    return fs.existsSync(sj) ? JSON.parse(fs.readFileSync(sj, "utf8")) : null;
  })();
  const name = `${tag ? tag + "-" : ""}${path.basename(clip, ".ndjson")}-${browser}-${pace}`;
  console.log(`replay ${name}`);
  await record(page, name, async () => {
    await page.evaluate(
      (nd, pace, arrivals) => {
        const lines = nd.split("\n").filter((l) => l.trim());
        const body =
          pace === "instant"
            ? nd
            : new ReadableStream({
                async start(c) {
                  const enc = new TextEncoder();
                  const t0 = performance.now();
                  for (let i = 0; i < lines.length; i++) {
                    // arrival time of line i (ms after the request) from a real first-time Speak, else 4× real time
                    let at;
                    if (pace === "stream" && arrivals && arrivals[i] != null) at = arrivals[i];
                    else {
                      const j = JSON.parse(lines[i]);
                      const sec = j.audio_base64 ? (atob(j.audio_base64).length / 2 / 24000) : 0;
                      window.__lsqaPaceSec = (window.__lsqaPaceSec || 0) + sec;
                      // "stream": 4× real time (a quick connection); "slow": 0.85× (the audio can't keep up: underruns)
                      at = 600 + (window.__lsqaPaceSec * 1000) / (pace === "slow" ? 0.85 : 4);
                    }
                    const wait = at - (performance.now() - t0);
                    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                    c.enqueue(enc.encode(lines[i] + "\n"));
                  }
                  window.__lsqaPaceSec = 0;
                  c.close();
                },
              });
        window.__faceToVoice.speech.speak(() => Promise.resolve(new Response(body, { headers: { "content-type": "application/x-ndjson" } })));
      },
      nd,
      pace,
      arrivals,
    );
    await sleep(300);
  }, { meta: { kind: "replay", clip: path.resolve(clip), pace, browser } });
  await sleep(600);
}
await br.close();
