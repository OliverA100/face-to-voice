/*
 * The stuck Safari output (stale.mjs) in the app itself: a saved line through the app's player, then the tab idle for
 * --hide s behind another tab, then the same line again; each recorded with the screen and the Mac mic. --cal plays a
 * beep track (out/beeps.ndjson) and flashes a patch while the app's player says a beep is heard: score it with
 * `uv run appcal.py <tag>-before <tag>-after` (flash vs beep on the long marker beeps; the mouth-pixel version was too
 * weak to trust). --url2: a second site in another tab, idle alongside (e.g. the live site as the control).
 *
 *   node appstale.mjs --cal --clip out/beeps.ndjson [--url http://localhost:3041/?debug=1] [--url2 …] [--hide 600]
 *                     [--tag app] [--tag2 app2]      APP_INSTANT=1: the line arrives at once (else after 0.6 s)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { OUT, autoCrop, headReady, launch, open, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const url = opt("url", "http://localhost:3041/?debug=1");
const hide = Number(opt("hide", "600"));
const tag = opt("tag", "app");
const clip = opt("clip", "out/clips/A-plosive.ndjson");
const ROOM = path.join(OUT, "room");
fs.mkdirSync(ROOM, { recursive: true });
const osa = (script) => execFileSync("osascript", ["-e", script]);

function startCapture(file, seconds) {
  const region = process.env.ROOM_REGION || "0,0,900,1117";
  fs.rmSync(file, { force: true });
  const sc = spawn("screencapture", ["-v", "-V", String(Math.ceil(seconds)), "-g", "-x", "-R", region, file], { stdio: "ignore" });
  const ended = new Promise((done) => sc.on("exit", done));
  return { stop: () => ended };
}

const br = await launch({ browser: "safari" });
const page = await open(br, url);
const wd = async (method, u, body) => (await (await fetch(`http://127.0.0.1:4444/session/${br.id}${u}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()).value;
const nd = fs.readFileSync(clip, "utf8");
const secs = nd.split("\n").reduce((a, l) => a + (l.trim() ? ((JSON.parse(l).audio_base64 || "").length * 0.75) / 2 / 24000 : 0), 0);

// one tab per page (--url2: a second one, e.g. the live site as the control), idle together, measured in turn: a
// WebDriver session drives one Safari window, and each site is its own process (its own audio output)
const tabs = [{ tag, url, handle: await wd("GET", "/window") }];
const url2 = opt("url2", null);
if (url2) {
  const t = await wd("POST", "/window/new", { type: "tab" });
  await wd("POST", "/window", { handle: t.handle });
  await page.goto(url2);
  tabs.push({ tag: opt("tag2", `${tag}2`), url: url2, handle: t.handle });
}
for (const t of tabs) {
  await wd("POST", "/window", { handle: t.handle });
  await headReady(page);
  t.crop = await autoCrop(page); // the lips, in the canvas's CSS px
  t.rect = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: window.screenX + r.x, y: window.screenY + (window.outerHeight - window.innerHeight) + r.y, w: r.width, h: r.height };
  });
}

// --cal: the clip is a beep track (out/beeps.ndjson: a beep each second, every 4th long) and a patch on the page
// flashes while the app's own player says a beep is being heard (speech.time()): flash vs beep in the capture = how
// far the sound is from where the app thinks it is (calibrate.html's rule, through the app's player and clock)
const calMode = opt("cal", null) !== null || !!process.env.APP_CAL;
const FLASH = () => {
  if (window.__flash) return;
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;left:50%;top:50%;width:360px;height:360px;margin:-180px 0 0 -180px;z-index:999999;background:#000;pointer-events:none";
  document.body.appendChild(d);
  window.__flash = d;
  const sp = window.__faceToVoice.speech;
  const tick = () => {
    requestAnimationFrame(tick);
    const t = sp.state === "playing" ? sp.time() : -1;
    let on = false;
    for (let k = 1; k <= 10; k++) if (t >= k && t < k + (k % 4 === 0 ? 0.18 : 0.06)) on = true;
    d.style.background = on ? "#fff" : "#000";
  };
  tick();
};

async function line(t, step) {
  await wd("POST", "/window", { handle: t.handle });
  osa('tell application "Safari" to activate'); // in front: the capture records the screen
  await sleep(1200);
  const name = `${t.tag}-${step}`;
  const cap = startCapture(path.join(ROOM, name + ".mov"), secs + 5);
  await sleep(1500);
  await page.mouse.click(300, 300); // a tap (Safari: audio from a gesture)
  if (calMode) await page.evaluate(FLASH);
  await page.evaluate(() => window.__faceToVoice.speech.unlock());
  // the line arrives as from the speak route (~0.6 s after the tap), unless --instant
  const wait = process.env.APP_INSTANT ? 0 : 600;
  await page.evaluate((nd, wait) => window.__faceToVoice.speech.speak(() => new Promise((ok) => setTimeout(() => ok(new Response(nd)), wait))), nd, wait);
  await cap.stop();
  const state = await page.evaluate(() => window.__faceToVoice.speech.state);
  const win = await page.evaluate(() => ({ x: window.screenX, y: window.screenY + (window.outerHeight - window.innerHeight), w: window.innerWidth, h: window.innerHeight }));
  fs.writeFileSync(path.join(ROOM, name + ".json"), JSON.stringify({ rect: t.rect, crop: t.crop, clip, state, url: t.url, cal: calMode, win }));
  console.log(name, state, JSON.stringify(t.crop));
}

for (const t of tabs) await line(t, "before");
if (process.env.APP_IDLER) {
  // the old player's habit, on purpose: a context left running with nothing to play (it stuck the tab's 48 kHz output
  // after ~10 min unwatched): does the route still play on time?
  for (const t of tabs) {
    await wd("POST", "/window", { handle: t.handle });
    await page.mouse.click(300, 300);
    console.log("idler:", await page.evaluate(async () => { const c = (window.__idler = new AudioContext()); const o = c.createConstantSource(); o.offset.value = 0; o.connect(c.destination); o.start(); await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 2000))]); return c.state + " " + c.sampleRate; }));
  }
}
if (process.env.APP_CUT) {
  // a line cut off half way (Stop), then the next straight after: its sound must not wait behind the cut one's
  for (const t of tabs) {
    await wd("POST", "/window", { handle: t.handle });
    await page.mouse.click(300, 300);
    await page.evaluate(() => window.__faceToVoice.speech.unlock());
    await page.evaluate((nd) => window.__faceToVoice.speech.speak(() => Promise.resolve(new Response(nd))), nd);
    await sleep(4300);
    await page.evaluate(() => window.__faceToVoice.speech.stop());
    await sleep(300);
    await line(t, "aftercut");
  }
}
await sleep(1500);
const other = await wd("POST", "/window/new", { type: "tab" });
await wd("POST", "/window", { handle: other.handle });
await wd("POST", "/url", { url: "about:blank" });
console.log(`behind another tab for ${hide} s`);
await sleep(hide * 1000);
await wd("DELETE", "/window");
for (const t of tabs) await line(t, "after");
if (process.env.APP_RELOAD) {
  // a reload keeps a stuck output (the backlog even played on after one): each tab reloaded, then the line again
  for (const t of tabs) {
    await wd("POST", "/window", { handle: t.handle });
    await page.goto(t.url);
    await headReady(page);
    await line(t, "reloaded");
  }
}
await br.close();
