/*
 * Real Speak runs on a deployment (the site's own buttons, the real /api/voice/speak): makes a character, gives it a
 * voice, then records each test line the first time (paid, streamed) and optionally again (the cache).
 *
 *   node speak.mjs --url <deployment> --char <label> [--random] [--take 0|1|2] [--browser chrome|firefox|safari]
 *                  [--lines plosive,fv,...] [--emotion Happy] [--cached] [--cachedOnly] [--skin fair] [--age -1..1]
 *                  [--lookOnly] [--set lines.json]   (--lookOnly: roll and save the face, no voice: look at out/chars/<char>.png first)
 *
 * Every Speak response is saved to out/clips/<char>-<line>[-<emotion>].ndjson (+ .arrivals.json: each NDJSON line's
 * arrival time), so replay.mjs can play the very same audio in other browsers for free.
 * Costs: --random = one voice design + one save; each first-time line = its characters in TTS credits.
 */
import fs from "node:fs";
import path from "node:path";

import { OUT, clickText, headReady, launch, open, record, setLine, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const url = opt("url");
const char = opt("char", "default");
const take = Number(opt("take", 0));
const browser = opt("browser", "chrome");
const emotion = opt("emotion", null);
const cached = !!opt("cached", false);
const cachedOnly = !!opt("cachedOnly", false);
// --set <file.json>: another set of lines ({ lines: [{ id, text }] }), e.g. a held-out set kept out of the repo
const { lines } = JSON.parse(fs.readFileSync(opt("set", null) ?? new URL("./lines.json", import.meta.url)));
const wanted = opt("lines", null);
const todo = wanted ? lines.filter((l) => wanted.split(",").includes(l.id)) : lines;
const CLIPS = path.join(OUT, "clips");
fs.mkdirSync(CLIPS, { recursive: true });

const br = await launch({ browser });
// --restore <char>: reopen a character made earlier (its face, look and chosen voice live in sessionStorage)
const restore = opt("restore", null);
if (restore) {
  const saved = JSON.parse(fs.readFileSync(path.join(OUT, "chars", `${restore}.session.json`), "utf8"));
  const pg = (await br.pages())[0] || (await br.newPage());
  await pg.evaluateOnNewDocument((kv) => {
    if (sessionStorage.getItem("__lsqaRestored")) return;
    for (const [k, v] of Object.entries(kv)) sessionStorage.setItem(k, v);
    sessionStorage.setItem("__lsqaRestored", "1");
  }, saved);
}
const page = await open(br, url + (url.includes("?") ? "&" : "?") + "debug=1");
page.on?.("response", (r) => {
  if (r.url().includes("/api/") && r.status() !== 200) console.log("  !", r.status(), new URL(r.url()).pathname);
});
await headReady(page);
console.log("head ready");

if (opt("random", false)) {
  // a random character without facial hair over the lips (the pixel measure needs to see them)
  for (let k = 0; k < 8; k++) {
    await clickText(page, /Random character/);
    await sleep(2500);
    const s = await page.evaluate(() => ({ ...window.__faceToVoice.addonState }));
    const hairy = Object.entries(s).some(([k, v]) => /facial|beard|moust/i.test(k) && v && v !== "none");
    if (!hairy) break;
  }
}
// --skin <tone id>: a light skin tone before the voice is made, so the pixel measure can see the open mouth
if (opt("skin", null)) {
  await page.evaluate((t) => window.__faceToVoice.setSkinTone(t), opt("skin"));
  await sleep(1000);
}
// --age <-1..1>: the Age slider (Shape tab), with the keyboard as a visitor would (the slider reads its own events)
if (opt("age", null) !== null) {
  const v = Math.max(-1, Math.min(1, Number(opt("age"))));
  await page.focus('input[type=range][aria-label="Age"]');
  await page.keyboard.press(v < 0 ? "Home" : "End");
  for (let k = 0; k < Math.round((1 - Math.abs(v)) / 0.01); k++) await page.keyboard.press(v < 0 ? "ArrowRight" : "ArrowLeft");
  await sleep(2500); // the head reshapes
}
await sleep(1500);
const charDir = path.join(OUT, "chars");
fs.mkdirSync(charDir, { recursive: true });
await (await page.$("canvas")).screenshot({ path: path.join(charDir, `${char}.png`) });
fs.writeFileSync(path.join(charDir, `${char}.json`), JSON.stringify(await page.evaluate(() => ({ look: window.__faceToVoice.currentLook?.(), addons: { ...window.__faceToVoice.addonState } })), null, 1));
const saveSession = async () =>
  fs.writeFileSync(path.join(charDir, `${char}.session.json`), JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))), null, 1));
// --lookOnly: stop here (no voice design): out/chars/<char>.png to look at, and a session to --restore later
if (opt("lookOnly", false)) {
  await saveSession();
  console.log(`look saved: out/chars/${char}.png (--restore ${char})`);
  await br.close();
  process.exit(0);
}

// voice: Find my voice → the take's "Use voice"
console.log("finding the voice");
// a restored character comes back on its voice (the Speak box): pressing Find my voice would design and pick a
// voice again for nothing
await sleep(1500);
if (!(await page.$('textarea[aria-label="Text to speak"]'))) await clickText(page, /Find my voice|New voices/);
// a face whose voice was already chosen goes straight to Speak; otherwise the three takes appear
await page.waitForFunction(() => document.querySelector('textarea[aria-label="Text to speak"]') || [...document.querySelectorAll("button")].some((b) => /Use voice/.test(b.textContent || "")), { timeout: 240_000, polling: 500 });
await sleep(1000);
const picked = await page.evaluate((take) => {
  const bs = [...document.querySelectorAll("button")].filter((b) => /Use voice/.test(b.textContent || "") && b.offsetParent);
  if (!bs.length) return "already chosen";
  (bs[take] || bs[0]).click();
  return `take ${take}`;
}, take);
console.log("voice:", picked);
await page.waitForSelector('textarea[aria-label="Text to speak"]', { timeout: 120_000 });
await sleep(1000);

// --emotion takes a list ("-" = keep the face's own expression): each pass speaks the lines with that expression on
let feeling = "";
async function setExpression(e) {
  if (e && e !== "-") {
    await clickText(page, /^Expression$/);
    await sleep(500);
    await clickText(page, new RegExp(`^${e}$`));
    await sleep(1500);
  }
  // label runs with the expression actually on the face (a random character brings its own)
  feeling = await page.evaluate(() => window.__faceToVoice.emotion.rig.current);
  console.log("expression:", feeling);
}

async function speakOnce(line, suffix) {
  const name = `${char}-${line.id}-${feeling}-${browser}-${suffix}`;
  console.log(`speak ${name}`);
  await setLine(page, line.text);
  await sleep(300);
  const dir = await record(
    page,
    name,
    async () => {
      await clickText(page, /^\s*Speak\s*$/);
      await page.waitForFunction(() => ["loading", "playing"].includes(window.__faceToVoice.speech.state), { timeout: 15_000, polling: 50 }).catch(() => {});
    },
    { meta: { kind: "speak", char, take, line: line.id, text: line.text, emotion: feeling, browser, path: suffix } },
  );
  const sj = JSON.parse(fs.readFileSync(path.join(dir, "speak.json"), "utf8"));
  const s = sj.at(-1);
  if (s && s.status === 200 && suffix === "first") {
    const base = path.join(CLIPS, `${char}-${line.id}-${feeling}`);
    fs.writeFileSync(base + ".ndjson", s.text);
    // arrival time (ms after the request was answered) of each NDJSON line, for paced replays
    let bytes = 0;
    const ends = [];
    for (const l of s.text.split("\n")) {
      bytes += Buffer.byteLength(l) + 1;
      ends.push(bytes);
    }
    let ci = 0, got = 0;
    const arr = [];
    for (const e of ends) {
      while (ci < s.chunks.length && got < e) got += s.chunks[ci++].n;
      arr.push(ci > 0 ? s.chunks[ci - 1].t - s.t0 : 0);
    }
    fs.writeFileSync(base + ".arrivals.json", JSON.stringify(arr));
  }
  if (s) console.log(`  ${s.status}, ${s.chunks.length} chunks, first ${s.chunks[0] ? Math.round(s.chunks[0].t - s.t0) : "-"} ms, all ${Math.round((s.done || 0) - s.t0)} ms`);
  await sleep(800);
}

await saveSession();

for (const e of emotion ? String(emotion).split(",") : ["-"]) {
  await setExpression(e);
  for (const line of todo) {
    if (!cachedOnly) await speakOnce(line, "first");
    if (cached || cachedOnly) await speakOnce(line, "cached");
  }
}
await br.close();
