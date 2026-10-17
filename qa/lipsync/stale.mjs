/*
 * Safari's stuck output after the background (a tab's sound ~0.8 s late, reported on time, kept across a
 * reload: the last line's sound even carries on after one). Reproduces it in a WebDriver Safari window and measures,
 * with the screen and the Mac mic (room.mjs, room.py), which ways out give the tab its sound on time again.
 *
 *   node serve.mjs &   then   STALE_IDLE=1 STALE_TAB=1 node stale.mjs [--hide 600] [--tag stale]   →  uv run calmark.py <tag>-cal-<k>-<step>
 *
 * Steps (one calibration each, flash vs beep): before, then --hide s away, then in the same tab: the same context, a
 * new one, one at 44.1 kHz, latencyHint "playback", the MediaStream → <audio> element route (STALE_RATE=44100: the
 * idle context at that rate, then new ones at it, 48 and 24 kHz). While away: silent (STALE_IDLE) or a murmur playing;
 * the page behind another tab (STALE_TAB), the window minimised (STALE_MIN), the display asleep (STALE_SLEEP) or
 * Safari hidden; STALE_SUSPEND: the context suspended while idle.
 * Found: idle and running 10 min → that rate's output stuck (silent or late) for the tab, new contexts at the
 * rate too; other rates on time; suspended while idle → on time.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { OUT, launch, open, record, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const hide = Number(opt("hide", "180"));
const tag = opt("tag", "stale");
const ROOM = path.join(OUT, "room");
fs.mkdirSync(ROOM, { recursive: true });

function startCapture(file, seconds) {
  const region = process.env.ROOM_REGION || "0,0,900,1117";
  fs.rmSync(file, { force: true });
  const sc = spawn("screencapture", ["-v", "-V", String(Math.ceil(seconds)), "-g", "-x", "-R", region, file], { stdio: "ignore" });
  const ended = new Promise((done) => sc.on("exit", done));
  return { stop: () => ended };
}
const screenRect = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    const top = window.screenY + (window.outerHeight - window.innerHeight);
    return { x: window.screenX + r.x, y: top + r.y, w: r.width, h: r.height, dpr: devicePixelRatio };
  });
const osa = (script) => execFileSync("osascript", ["-e", script]);

const br = await launch({ browser: "safari" });
const page = await open(br, "http://localhost:3199/calibrate.html?mode=heard");
await sleep(1500);
// a click: Safari only starts audio from a user gesture
const go = await page.evaluate(() => { const b = document.querySelector("#go").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });

let k = 0;
async function measure(step, opts) {
  const name = `${tag}-cal-${k++}-${step}`;
  // the test window in front (the person may be using the Mac): the capture records the screen, the click must land
  osa('tell application "Safari" to activate');
  await sleep(800);
  const cap = startCapture(path.join(ROOM, name + ".mov"), 15);
  await sleep(1500);
  const rect = await screenRect(page);
  let info = null;
  await record(page, name, async () => {
    await page.evaluate((o) => (window.calNext = o), opts);
    await page.mouse.click(go[0], go[1]);
    await sleep(10_000);
    info = await page.evaluate(() => window.calInfo);
  }, { tail: 200, meta: { kind: "room-cal", browser: "safari", screenRect: rect, crop: false, step, opts } });
  await cap.stop();
  console.log(name, JSON.stringify(info));
}

// STALE_RATE: the context left idle runs at that rate (Hz), e.g. 44100
const rate = Number(process.env.STALE_RATE) || 0;
await measure("before", rate ? { fresh: true, sampleRate: rate } : {});
if (process.env.STALE_MIC) {
  // a chat: the mic on while the voice plays (the murmur), then off; then another app in front a moment (the reported
  // case: chat, click another app's window, back, another chat → the delay)
  await page.evaluate(() => window.calFill(true));
  console.log("mic:", await page.evaluate(() => window.calMic(true)));
  await sleep(20_000);
  console.log("mic:", await page.evaluate(() => window.calMic(false)));
  await page.evaluate(() => window.calFill(false));
  await measure("aftermic", {});
  osa('tell application "Finder" to activate');
  await sleep(Number(process.env.STALE_AWAY || 10) * 1000);
  await measure("afterapp", {});
  await measure("element", { route: "element" });
  await measure("direct", { route: "direct" });
  await measure("fresh44", { fresh: true, sampleRate: 44100 });
  await br.close();
  process.exit(0);
}
if (process.env.STALE_IDLE) {
  // nothing playing while it waits: the context idle, as the app's between lines (user: "an idle tab for a while")
  await page.evaluate(() => window.calQuiet(true));
  if (process.env.STALE_SUSPEND) {
    await sleep(3500); // the beeps already queued play out
    console.log("suspended:", await page.evaluate(() => window.calSuspend()));
  }
} else {
  // the murmur plays on while the window is away
  await page.evaluate(() => window.calFill(true));
}
await sleep(1000);
if (process.env.STALE_VISIBLE) {
  console.log(`idle in front for ${hide} s`);
  await sleep(hide * 1000);
} else if (process.env.STALE_TAB) {
  // the test page hidden behind a new tab in its own window (no Accessibility permission needed; other windows untouched)
  const wd = async (method, url, body) => (await (await fetch(`http://127.0.0.1:4444/session/${br.id}${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()).value;
  const mine = await wd("GET", "/window");
  const other = await wd("POST", "/window/new", { type: "tab" });
  await wd("POST", "/window", { handle: other.handle });
  await wd("POST", "/url", { url: "about:blank" });
  console.log(`test page behind another tab for ${hide} s`, JSON.stringify(await page.evaluate(() => document.visibilityState)));
  await sleep(hide * 1000);
  await wd("DELETE", "/window");
  await wd("POST", "/window", { handle: mine });
  await sleep(1500);
  console.log("back:", JSON.stringify(await page.evaluate(() => document.visibilityState)));
} else if (process.env.STALE_MIN) {
  // only this window minimised (the page hidden); the person's other Safari windows stay as they are
  const min = (on) => osa(`tell application "System Events" to tell process "Safari" to set value of attribute "AXMinimized" of (first window whose name contains "calibration") to ${on}`);
  min(true);
  console.log(`test window minimised for ${hide} s`);
  await sleep(hide * 1000);
  min(false);
  await sleep(1500);
  osa('tell application "Safari" to activate');
} else if (process.env.STALE_SLEEP) {
  // the display asleep (the screen black), as when the person steps away; then woken (user activity)
  console.log(`display asleep for ${hide} s`);
  execFileSync("pmset", ["displaysleepnow"]);
  await sleep(hide * 1000);
  execFileSync("caffeinate", ["-u", "-t", "3"]);
  await sleep(4000);
  osa('tell application "Safari" to activate');
} else {
  osa('tell application "System Events" to set visible of process "Safari" to false');
  console.log(`Safari hidden for ${hide} s`);
  await sleep(hide * 1000);
  osa('tell application "Safari" to activate');
}
await sleep(2000);
await page.evaluate(() => window.calFill(false));
if (rate) {
  // which rates play again after the idle one got stuck
  await measure("same", {});
  await measure(`fresh${rate}`, { fresh: true, sampleRate: rate });
  await measure("fresh48000", { fresh: true, sampleRate: 48000 });
  await measure("fresh24000", { fresh: true, sampleRate: 24000 });
  await measure(`again${rate}`, { fresh: true, sampleRate: rate });
} else {
  await measure("same", {});
  await measure("fresh", { fresh: true });
  await measure("fresh44", { fresh: true, sampleRate: 44100 });
  await measure("playback", { fresh: true, hint: "playback" });
  await measure("element", { fresh: true, route: "element" });
}
await br.close();
