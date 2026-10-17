/*
 * Shared driver code: launch a browser, open the site with inject.js installed before any page script, record while
 * something speaks, and write the run to disk (out/runs/<name>/):
 *   frames.jsonl   one row per rendered frame (clocks, app values with ?debug)
 *   audio-<ctx>.wav  exactly what the page sent to the speakers, sample 0 = ctx time `startTime` in meta.json
 *   mouth/NNNNNN.jpg, full/NNNNNN.jpg  frame grabs (NNNNNN = frame index in frames.jsonl)
 *   speak.json     /api/voice/speak responses (NDJSON text + chunk arrival times)
 *   meta.json      browser, url, viewport, contexts, marks, errors
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const OUT = path.join(HERE, "out");
const INJECT = fs.readFileSync(path.join(HERE, "inject.js"), "utf8");

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  firefox: { browser: "firefox", executablePath: process.env.FIREFOX_PATH ?? "/Applications/Firefox.app/Contents/MacOS/firefox" },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ browser = "chrome", headless = false, width = 1440, height = 900, scale = 2, args = [] } = {}) {
  if (browser === "safari") return (await import("./safari.mjs")).launchSafari();
  const b = BROWSERS[browser];
  const profile = path.join(OUT, `profile-${browser}`);
  const opts = {
    ...b,
    headless,
    userDataDir: profile,
    defaultViewport: { width, height, deviceScaleFactor: scale },
    args:
      browser === "chrome"
        ? ["--autoplay-policy=no-user-gesture-required", `--window-size=${width},${height + 100}`, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...args]
        : args,
    ...(browser === "firefox" ? { extraPrefsFirefox: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } } : {}),
  };
  return puppeteer.launch(opts);
}

const VERCEL_BYPASS_FILE = path.join(OUT, "vercel-bypass.txt");

/** Preview deployments sit behind Vercel's login: the "Protection Bypass for Automation" secret, sent once as query
 * parameters, sets a cookie for that deployment only (a header would also reach LiveKit and Blob). */
export function withVercelBypass(url) {
  if (!/\.vercel\.app/.test(url) || !fs.existsSync(VERCEL_BYPASS_FILE)) return url;
  const u = new URL(url);
  u.searchParams.set("x-vercel-protection-bypass", fs.readFileSync(VERCEL_BYPASS_FILE, "utf8").trim());
  u.searchParams.set("x-vercel-set-bypass-cookie", "samesitenone");
  return u.toString();
}

export async function open(br, url) {
  const page = (await br.pages())[0] || (await br.newPage());
  await page.evaluateOnNewDocument(INJECT);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warn") console.log(`  [page ${m.type()}] ${m.text().slice(0, 200)}`);
  });
  await page.goto(withVercelBypass(url), { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(() => window.__lsqa, { timeout: 30_000 });
  return page;
}

/** Waits for the head to be on screen (works without ?debug: the canvas has drawn the skin colour). */
export async function headReady(page) {
  await page.waitForFunction(() => document.querySelector("canvas") && (window.__faceToVoice ? window.__faceToVoice.perf?.headVisibleMs > 0 : document.querySelector("canvas").width > 0), { timeout: 90_000 });
  await sleep(2500);
}

/** Centres the mouth crop on the lips: a canvas screenshot → findcrop.py (connected red blobs). */
export async function autoCrop(page) {
  const { execFileSync } = await import("node:child_process");
  const el = await page.$("canvas");
  const box = await page.evaluate((c) => c.getBoundingClientRect().width, el);
  const png = path.join(OUT, "crop.png");
  await el.screenshot({ path: png });
  const res = execFileSync("uv", ["run", "-q", path.join(HERE, "findcrop.py"), png, String(box)], { cwd: HERE }).toString().trim();
  const crop = JSON.parse(res);
  await page.evaluate((k) => {
    if (k) window.__lsqa.crop = k;
    window.__lsqa.recrop = false;
  }, crop);
  return crop;
}

/** Records while `fn` runs, then until the line has finished playing; writes the run. */
export async function record(page, name, fn, { tail = 800, maxMs = 60_000, meta = {} } = {}) {
  const dir = path.join(OUT, "runs", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "mouth"), { recursive: true });
  fs.mkdirSync(path.join(dir, "full"), { recursive: true });
  const frames = fs.createWriteStream(path.join(dir, "frames.jsonl"));
  const audio = new Map(); // ctx -> {sr, chunks:[{f, i16}]}
  const marks = [];
  const errors = [];
  let images = 0;
  const speakBefore = await page.evaluate(() => window.__lsqa.speak.length);
  const drain = async (max) => {
    const d = await page.evaluate((m) => window.__lsqa.drain(m), max);
    for (const row of d.frames) frames.write(JSON.stringify(row) + "\n");
    for (const a of d.audio) {
      if (!audio.has(a.ctx)) audio.set(a.ctx, { sr: a.sr, chunks: [] });
      const bb = Buffer.from(a.b64, "base64");
      audio.get(a.ctx).chunks.push({ f: a.f, i16: new Int16Array(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength)) });
    }
    for (const im of d.images) {
      fs.writeFileSync(path.join(dir, im.kind, String(im.i).padStart(6, "0") + ".jpg"), Buffer.from(im.b64, "base64"));
      images++;
    }
    marks.push(...d.marks);
    errors.push(...d.errors);
    return d.pending;
  };
  if (meta.crop !== false) meta.cropBox = await autoCrop(page).catch((e) => (console.log("  autoCrop failed:", e.message), null));
  await page.evaluate(() => window.__lsqa.start());
  const t0 = Date.now();
  let draining = true;
  const loop = (async () => {
    while (draining) {
      await drain(200);
      await sleep(250);
    }
  })();
  await fn();
  // until the speech is over: debug → player/live state; otherwise the Speak bar's "Speaking…" label
  await page
    .waitForFunction(
      () => {
        const F = window.__faceToVoice;
        if (F) {
          const s = F.speech.state;
          const live = F.liveSpeech;
          return s !== "loading" && s !== "playing" && !(live && live.playing);
        }
        return ![...document.querySelectorAll("span")].some((s) => /^(Speaking|Generating)…$/.test(s.textContent || ""));
      },
      { timeout: maxMs, polling: 100 },
    )
    .catch(() => console.log("  (timed out waiting for the line to end)"));
  await sleep(tail);
  await page.evaluate(() => window.__lsqa.stop());
  draining = false;
  await loop;
  for (let k = 0; k < 40; k++) if ((await drain(400)) === 0 && k > 1) break; else await sleep(150);
  frames.end();
  const speak = await page.evaluate((n) => window.__lsqa.speakLog().slice(n), speakBefore);
  fs.writeFileSync(path.join(dir, "speak.json"), JSON.stringify(speak, null, 1));
  const ctxInfo = await page.evaluate(() => window.__lsqa.contexts());
  const wavs = {};
  for (const [ctx, a] of audio) {
    a.chunks.sort((x, y) => x.f - y.f);
    const f0 = a.chunks[0].f;
    const end = a.chunks.at(-1).f + a.chunks.at(-1).i16.length;
    const all = new Int16Array(end - f0);
    for (const c of a.chunks) all.set(c.i16, c.f - f0);
    const file = `audio-${ctx}.wav`;
    writeWav(path.join(dir, file), all, a.sr);
    wavs[ctx] = { file, sr: a.sr, startFrame: f0, startTime: f0 / a.sr, seconds: all.length / a.sr };
  }
  const ua = await page.evaluate(() => navigator.userAgent);
  const m = { name, url: page.url(), ua, ms: Date.now() - t0, images, contexts: ctxInfo, wavs, marks, errors, ...meta };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(m, null, 1));
  console.log(`  run ${name}: ${images} images, ${[...audio.keys()].length} audio ctx, ${errors.length} errors`);
  if (errors.length) console.log("  errors:", errors.slice(0, 5));
  return dir;
}

export function writeWav(file, i16, sr) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + i16.length * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(i16.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength)]));
}

// ---------------- the site's own UI ----------------
/** Clicks the first visible button/link/tab whose label or text matches (`last`: the last one, e.g. a card's own
 *  "Meet" button rather than the "Meet" step above it). */
export async function clickText(page, re, { timeout = 60_000, last = false } = {}) {
  const h = await page.waitForFunction(
    (src, last) => {
      const r = new RegExp(src);
      const all = [...document.querySelectorAll("button,a,[role=button],[role=radio],[role=tab]")].filter((b) => (r.test((b.getAttribute("aria-label") || "").trim()) || r.test((b.textContent || "").trim())) && b.offsetParent !== null);
      return last ? all.at(-1) : all[0];
    },
    { timeout, polling: 200 },
    re.source,
    last,
  );
  await h.asElement().click();
}

/** Puts a line in the Speak bar (React controlled textarea: the native value setter + an input event). */
export async function setLine(page, text) {
  await page.waitForSelector('textarea[aria-label="Text to speak"]', { timeout: 60_000 });
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea[aria-label="Text to speak"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}
