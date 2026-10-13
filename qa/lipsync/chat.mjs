/*
 * A real live conversation on a deployment (LiveKit + the cloud agent), recorded reply by reply. The visitor is the
 * WAVs in out/visitor (macOS `say`, see README), fed to the page as its microphone.
 *
 *   node chat.mjs --url <deployment> --char <label> [--restore <char>] [--browser chrome|firefox] [--turns 3]
 *
 * Each reply (the greeting included) is one run, out/runs/<char>-chat<k>-<browser>; the words the agent sent for it
 * are saved in meta.json "text" for truth.py. Costs: one profile (Claude, first visit only) + the chat's minutes.
 */
import fs from "node:fs";
import path from "node:path";

import { OUT, clickText, headReady, launch, open, record, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const url = opt("url");
const char = opt("char", "A");
const browser = opt("browser", "chrome");
const turns = Number(opt("turns", 3));
const restore = opt("restore", null);
const visitor = fs
  .readdirSync(path.join(OUT, "visitor"))
  .filter((f) => f.endsWith(".wav"))
  .sort()
  .map((f) => fs.readFileSync(path.join(OUT, "visitor", f)).toString("base64"));

const br = await launch({ browser, args: ["--use-fake-ui-for-media-stream"] });
const pg = (await br.pages())[0] || (await br.newPage());
if (restore) {
  const saved = JSON.parse(fs.readFileSync(path.join(OUT, "chars", `${restore}.session.json`), "utf8"));
  await pg.evaluateOnNewDocument((kv) => {
    if (sessionStorage.getItem("__lsqaRestored")) return;
    for (const [k, v] of Object.entries(kv)) sessionStorage.setItem(k, v);
    sessionStorage.setItem("__lsqaRestored", "1");
  }, saved);
}
// the microphone: a MediaStream from Web Audio that plays the visitor's WAVs on cue (__lsqaSay(i)), silence otherwise
await pg.evaluateOnNewDocument((clips) => {
  let ctx, dest;
  const buffers = [];
  const ready = (async () => {})();
  const fake = async () => {
    ctx = ctx || new AudioContext();
    dest = dest || ctx.createMediaStreamDestination();
    if (!buffers.length)
      for (const b64 of clips) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        buffers.push(await ctx.decodeAudioData(bin.buffer));
      }
    await ctx.resume();
    // a fresh track each time: the app's mic check stops the one it gets
    return new MediaStream([dest.stream.getAudioTracks()[0].clone()]);
  };
  // on the prototype too: Safari ignores an own-property assignment on navigator.mediaDevices
  Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value: fake, configurable: true, writable: true });
  try {
    navigator.mediaDevices.getUserMedia = fake;
  } catch {}
  window.__lsqaSay = (i) => {
    const s = ctx.createBufferSource();
    s.buffer = buffers[i % buffers.length];
    s.connect(dest);
    s.start();
    return s.buffer.duration;
  };
  void ready;
}, visitor);

const page = await open(br, url + (url.includes("?") ? "&" : "?") + "debug=1");
page.on("response", (r) => {
  if (r.url().includes("/api/") && r.status() !== 200) console.log("  !", r.status(), new URL(r.url()).pathname);
});
await headReady(page);

// to the Meet step (a chosen voice is restored straight onto Speak), then Chat
if (!(await page.$('textarea[aria-label="Text to speak"]'))) {
  await clickText(page, /Find my voice|New voices/);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Text to speak"]') || [...document.querySelectorAll("button")].some((b) => /Use voice/.test(b.textContent || "")), { timeout: 240_000, polling: 500 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Use voice/.test(b.textContent || "") && b.offsetParent)?.click());
  await page.waitForSelector('textarea[aria-label="Text to speak"]', { timeout: 120_000 });
}
await clickText(page, /^Meet$/);
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Chat$/.test((b.textContent || "").trim()) && b.offsetParent), { timeout: 120_000, polling: 300 });

const wordsNow = () =>
  page.evaluate(() => {
    const L = window.__faceToVoice.liveSpeech;
    return L && L.words ? L.words.map((w) => w.w).join(" ") : "";
  });
const playing = () => page.evaluate(() => !!window.__faceToVoice.liveSpeech?.playing);

for (let k = 0; k <= turns; k++) {
  const name = `${char}-chat${k}-${browser}`;
  console.log(k === 0 ? "greeting…" : `visitor says line ${k - 1}…`);
  let text = "";
  await record(
    page,
    name,
    async () => {
      if (k === 0) await clickText(page, /^Chat$/);
      if (k > 0) {
        const d = await page.evaluate((i) => window.__lsqaSay(i), k - 1);
        await sleep(d * 1000);
      }
      // the character's reply: up to 90 s for the first (agent wake-up), then 30 s
      await page.waitForFunction(() => !!window.__faceToVoice.liveSpeech?.playing, { timeout: k === 0 ? 90_000 : 30_000, polling: 100 });
      // words arrive while it speaks: keep the longest seen
      const poll = setInterval(async () => {
        const w = await wordsNow().catch(() => "");
        if (w.length > text.length) text = w;
      }, 200);
      await page.waitForFunction(() => !window.__faceToVoice.liveSpeech?.playing, { timeout: 60_000, polling: 100 });
      clearInterval(poll);
    },
    { tail: 300, maxMs: 5000, meta: { kind: "chat", char, browser, turn: k } },
  );
  const mp = path.join(OUT, "runs", name, "meta.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.text = text;
  fs.writeFileSync(mp, JSON.stringify(m, null, 1));
  console.log(`  said: ${text.slice(0, 120)}`);
  if (!(await playing())) await sleep(800);
}
await clickText(page, /^End/).catch(() => {});
await sleep(1500);
await br.close();
