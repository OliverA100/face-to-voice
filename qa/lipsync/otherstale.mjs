/*
 * Safari's stuck output (appstale.mjs), looked for in Chrome and Firefox: the app's beep track (out/beeps.ndjson)
 * through its player with a patch flashing on its clock, then a context left running with nothing to play (the old
 * player's habit) and the tab behind another for --hide s, then the beeps again. Normal browser settings: no
 * background-throttling switches. Score with `uv run appcal.py <tag>-before <tag>-after`.
 *
 *   node otherstale.mjs --browser chrome|firefox [--url http://localhost:3041/?debug=1] [--hide 600] [--tag chr]
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import puppeteer from "puppeteer-core";

import { OUT, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const browser = opt("browser", "chrome");
const url = opt("url", "http://localhost:3041/?debug=1");
const hide = Number(opt("hide", "600"));
const tag = opt("tag", browser.slice(0, 3));
const ROOM = path.join(OUT, "room");
const APP = { chrome: "Google Chrome", firefox: "Firefox" }[browser];
const exe = { chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", firefox: "/Applications/Firefox.app/Contents/MacOS/firefox" }[browser];

function startCapture(file, seconds) {
  fs.rmSync(file, { force: true });
  const sc = spawn("screencapture", ["-v", "-V", String(Math.ceil(seconds)), "-g", "-x", "-R", process.env.ROOM_REGION || "0,0,900,1117", file], { stdio: "ignore" });
  return { stop: () => new Promise((done) => sc.on("exit", done)) };
}

const br = await puppeteer.launch({
  browser,
  executablePath: exe,
  headless: false,
  userDataDir: path.join(OUT, `profile-${browser}-plain`),
  defaultViewport: null,
  args: browser === "chrome" ? ["--window-position=0,0", "--window-size=900,1100"] : ["--width=900", "--height=1100"],
});
const page = (await br.pages())[0] ?? (await br.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__faceToVoice?.perf?.headVisibleMs > 0, { timeout: 90_000 });
await sleep(2500);
const nd = fs.readFileSync("out/beeps.ndjson", "utf8");

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

async function line(step) {
  await page.bringToFront();
  execFileSync("osascript", ["-e", `tell application "${APP}" to activate`]);
  await sleep(1200);
  const name = `${tag}-${step}`;
  const cap = startCapture(path.join(ROOM, name + ".mov"), 17);
  await sleep(1500);
  await page.mouse.click(300, 300);
  await page.evaluate(FLASH);
  await page.evaluate(() => window.__faceToVoice.speech.unlock());
  await page.evaluate((nd) => window.__faceToVoice.speech.speak(() => new Promise((ok) => setTimeout(() => ok(new Response(nd)), 600))), nd);
  await cap.stop();
  const state = await page.evaluate(() => window.__faceToVoice.speech.state);
  const win = await page.evaluate(() => ({ x: window.screenX, y: window.screenY + (window.outerHeight - window.innerHeight), w: window.innerWidth, h: window.innerHeight }));
  fs.writeFileSync(path.join(ROOM, name + ".json"), JSON.stringify({ state, url, cal: true, win, browser }));
  console.log(name, state);
}

await line("before");
// the old player's habit: a context running with nothing to play
await page.mouse.click(300, 300);
console.log("idler:", await page.evaluate(async () => { const c = (window.__idler = new AudioContext()); const o = c.createConstantSource(); o.offset.value = 0; o.connect(c.destination); o.start(); await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 2000))]); return c.state + " " + c.sampleRate; }));
const other = await br.newPage();
await other.goto("about:blank");
await other.bringToFront();
console.log(`behind another tab for ${hide} s`, await page.evaluate(() => document.visibilityState));
await sleep(hide * 1000);
await other.close();
await line("after");
await br.close();
