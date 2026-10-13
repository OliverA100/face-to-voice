/*
 * What a person in front of the Mac sees and hears: ffmpeg records the SCREEN and the MAC'S MICROPHONE on one
 * AVFoundation clock while a browser plays (the in-page recorder runs too, for the clean audio and the crop).
 * The speakers' real delay and the display's delay are both in this recording; the page knows neither.
 *
 *   node room.mjs --browser chrome|firefox|safari cal              calibrate.html?mode=heard (flash when heard)
 *   node room.mjs --browser chrome replay <clip.ndjson> [...]      saved lines through the live site's player
 *
 * Needs Screen Recording permission for the app running this. Output: out/room/<name>.mov + the run in out/runs.
 * Then: uv run room.py <name>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { OUT, headReady, launch, open, record, sleep } from "./lib.mjs";

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
const tag = opt("tag", "room");
const [mode, ...clips] = args;
const ROOM = path.join(OUT, "room");
fs.mkdirSync(ROOM, { recursive: true });

function startCapture(file, seconds) {
  // macOS's own recorder: screen + default mic (-g) on one clock, no dropped audio (ffmpeg's avfoundation input lost
  // ~14% of the mic samples under the screen-capture load). -R = the left part of the screen, where the window sits.
  const region = process.env.ROOM_REGION || "0,0,900,1117";
  fs.rmSync(file, { force: true }); // screencapture won't overwrite
  const sc = spawn("screencapture", ["-v", "-V", String(Math.ceil(seconds)), "-g", "-x", "-R", region, file], { stdio: "ignore" });
  const ended = new Promise((done) => sc.on("exit", done));
  return { stop: () => ended };
}

/** Where the canvas is on the screen (CSS px of the screen; ×2 on a Retina capture). */
const screenRect = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    const top = window.screenY + (window.outerHeight - window.innerHeight);
    return { x: window.screenX + r.x, y: top + r.y, w: r.width, h: r.height, dpr: devicePixelRatio };
  });

const br = await launch({ browser }); // native Retina density, like a visitor
if (mode === "cal") {
  const page = await open(br, `http://localhost:3199/calibrate.html?mode=heard`);
  await sleep(1500);
  const name = `${tag}-cal-${browser}`;
  const cap = startCapture(path.join(ROOM, name + ".mov"), 16);
  await sleep(1500);
  const rect = await screenRect(page);
  await record(
    page,
    name,
    async () => {
      const r = await page.evaluate(() => { const b = document.querySelector("#go").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
      await page.mouse.click(r[0], r[1]);
      await sleep(10_000);
    },
    { tail: 200, meta: { kind: "room-cal", browser, screenRect: rect, crop: false } },
  );
  await cap.stop();
} else {
  const page = await open(br, url);
  await headReady(page);
  await page.mouse.click(300, 300);
  await page.evaluate(() => window.__faceToVoice.speech.unlock?.());
  await sleep(500);
  for (const clip of clips) {
    const nd = fs.readFileSync(clip, "utf8");
    const name = `${tag}-${path.basename(clip, ".ndjson")}-${browser}`;
    console.log(name);
    // the line's length from its PCM (24 kHz, 16-bit, base64) + margins
    const secs = nd.split("\n").reduce((a, l) => a + (l.trim() ? (JSON.parse(l).audio_base64 || "").length * 0.75 / 2 / 24000 : 0), 0);
    const cap = startCapture(path.join(ROOM, name + ".mov"), secs + 7);
    await sleep(1500);
    const rect = await screenRect(page);
    await record(
      page,
      name,
      async () => {
        await page.evaluate((nd) => window.__faceToVoice.speech.speak(() => Promise.resolve(new Response(nd))), nd);
        await sleep(300);
      },
      { meta: { kind: "room", clip: path.resolve(clip), browser, screenRect: rect } },
    );
    await sleep(500);
    await cap.stop();
  }
}
await br.close();
