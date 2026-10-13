/*
 * Does lip sync cost frames on a phone? Chrome with a phone screen (390×844 @3×, touch) and the CPU slowed 4×: frame
 * intervals for 8 s with the head idle, then 8 s while a saved line plays. No recorder (it would cost frames itself).
 *
 *   node perf.mjs [--url https://facetovoice.com/] [--cpu 4] clip.ndjson
 */
import fs from "node:fs";

import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const url = opt("url", "https://facetovoice.com/");
const cpu = Number(opt("cpu", 4));
const clip = fs.readFileSync(args[0], "utf8");

const br = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await br.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36" });
await page.goto(url + (url.includes("?") ? "&" : "?") + "debug=1", { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForFunction(() => window.__faceToVoice?.perf?.headVisibleMs > 0, { timeout: 90_000 });
await new Promise((r) => setTimeout(r, 4000));
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
await page.evaluate(() => window.__faceToVoice.speech.unlock?.());

await cdp.send("Performance.enable");
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
// frame stats + main-thread script time per frame (CDP Performance metrics, includes the 4× slowdown)
const sample = async (ms) => {
  const a = await metrics();
  const r = await frames(ms);
  const b = await metrics();
  r.scriptMsPerFrame = +((1000 * (b.ScriptDuration - a.ScriptDuration)) / r.frames).toFixed(2);
  r.taskMsPerFrame = +((1000 * (b.TaskDuration - a.TaskDuration)) / r.frames).toFixed(2);
  return r;
};
const frames = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((done) => {
        const t = [];
        const loop = (ts) => {
          t.push(ts);
          if (ts - t[0] < ms) requestAnimationFrame(loop);
          else {
            const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
            done({ fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50: +d[d.length >> 1].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), max: +d.at(-1).toFixed(1), over33: d.filter((x) => x > 33.4).length, frames: d.length });
          }
        };
        requestAnimationFrame(loop);
      }),
    ms,
  );

const idle = await sample(8000);
await page.evaluate((nd) => window.__faceToVoice.speech.speak(() => Promise.resolve(new Response(nd))), clip);
await page.waitForFunction(() => window.__faceToVoice.speech.state === "playing", { timeout: 20_000, polling: 50 });
const speaking = await sample(Math.min(8000, 1000 * 6));
const idle2 = await (async () => {
  await page.waitForFunction(() => window.__faceToVoice.speech.state !== "playing", { timeout: 60_000, polling: 200 });
  await new Promise((r) => setTimeout(r, 1500));
  return sample(6000);
})();
console.log(JSON.stringify({ url, cpu, idle, speaking, idleAfter: idle2, dpr: await page.evaluate(() => document.querySelector("canvas").width / document.querySelector("canvas").getBoundingClientRect().width) }, null, 1));
await br.close();
