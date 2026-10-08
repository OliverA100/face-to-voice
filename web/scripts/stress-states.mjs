/**
 * Every face state the app itself makes, for the pipeline's exact geometry checks (`uv run validate --stress`, which
 * runs this script). Drives a running app in headless Chrome (the system Chrome, no download) through
 * window.__faceToVoice, so the limiter, Random face, the animation caps and the layers are the shipped code. The page is
 * opened with `debug=1` added to its query, so the handle exists in a production build too.
 *
 *   node scripts/stress-states.mjs [--quick] [--url http://localhost:3000]
 *     reads  ../pipeline/out/validation/stress_identities.json   (written by `uv run validate --stress`)
 *     writes ../pipeline/out/validation/stress_states.json
 *
 * Families:
 *   random     Random face at Distinctiveness 0.5 / 1 / 1.5 / 2 / 2.5 (seeded)
 *   character  Random character (the button, seeded)
 *   anim       each identity × 12 emotions at intensity 0.6 / 1, blink 0.7 / 1, each viseme while speaking, gaze at the
 *              pose limits with the lids following: the store's final weights (caps applied), plus the eye rotation
 * Each state: { family, id, identity, weights, gaze: [yawDeg, pitchDeg] (pitch > 0 = down), caps }. Random faces carry
 * slider values (weights as the sliders show them); character and animation states carry the store's final per-target
 * weights (`effective`: mix sliders spread, layers added, caps applied, clamped), flagged `effective: true`.
 * --quick: fewer random faces and characters, and 4 emotions at full intensity.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const VAL = path.join(here, "..", "..", "pipeline", "out", "validation");
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const url = new URL(args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000");
url.searchParams.set("debug", "1"); // installs window.__faceToVoice in a production build too (FaceBuilder.tsx)
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LEVELS = [0.5, 1, 1.5, 2, 2.5];
const PER_LEVEL = quick ? 40 : 300;
const CHARACTERS = quick ? 10 : 50;

const identities = JSON.parse(fs.readFileSync(path.join(VAL, "stress_identities.json"), "utf8")).identities;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", protocolTimeout: 1_800_000, args: ["--use-angle=metal"], defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url.href, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__faceToVoice?.perf?.headVisibleMs, { timeout: 120000 });
await page.waitForFunction(() => window.__faceToVoice.limits.limiter.ready, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000)); // head.extra.glb: the Shape targets
await page.evaluate(() => {
  window.__faceToVoice.still(true);
  // seeded Math.random (mulberry32): the same faces every run
  window.__seed = (s) => {
    let a = s >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
});
const states = [];

// --- random faces ---------------------------------------------------------------------------------------------------
const random = [];
for (const D of LEVELS) random.push(...await page.evaluate(async (D, PER) => {
  const F = window.__faceToVoice, R = F.random, defs = R.defs();
  const out = [];
  for (let k = 0; k < PER; k++) {
    window.__seed(70000 + k);
    const w = R.randomFace(defs, D);
    const f = R.randomState.lastFit;
    out.push({ family: "random", id: `D${D}-${k}`, level: D, weights: w, fit: { shrunk: f.shrunk, shortened: f.striking.filter((s) => Math.abs(s.got - s.wanted) > 1e-3).length } });
    if (k % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}, D, PER_LEVEL));
states.push(...random);
console.log(`random: ${random.length} faces`);

for (let k = 0; k < CHARACTERS; k++) {
  await page.evaluate((k) => {
    window.__seed(80000 + k);
    [...document.querySelectorAll("button")].find((b) => /^random character/i.test(b.textContent.trim())).click();
  }, k);
  await page.evaluate(() => window.__faceToVoice.characterSettled());
  states.push(await page.evaluate((k) => {
    const F = window.__faceToVoice;
    const m = F.morphs;
    const weights = Object.fromEntries(m.targets().map((t) => [t, m.effective(t)]).filter(([, v]) => v));
    return { family: "character", id: `character-${k}`, level: Number(document.querySelector('input[aria-label="Distinctiveness"]').value), weights, effective: true };
  }, k));
}
console.log(`characters: ${CHARACTERS}`);
await page.evaluate(() => { window.__faceToVoice.still(true); window.__faceToVoice.emotion.set("neutral", 0); });

// --- extreme identities × animation ------------------------------------------------------------------------------------
const anim = [];
for (const one of identities) anim.push(...await page.evaluate(async (identities, quick) => {
  const F = window.__faceToVoice, m = F.morphs, S = F.stress;
  const roles = S.visemes.roles;
  const blinkRole = { ...roles.blinkLeft, ...roles.blinkRight };
  const emotions = Object.keys(F.emotion.rig.weights).filter((e) => !e.startsWith("_")); // not GSAP's own "_gsap" key
  const visemeIds = Object.keys(S.visemes.visemes);
  const clearAnim = () => {
    for (const l of ["blink", "gaze", "viseme", "emotion"]) m.clearLayer(l);
    for (const e of emotions) F.emotion.rig.weights[e] = 0;
    S.setSpeechActivity(0);
    S.applyEmotion();
  };
  const snap = () => Object.fromEntries(m.targets().map((t) => [t, m.effective(t)]).filter(([, v]) => v));
  const out = [];
  for (const idn of identities) {
    // an identity is slider values, or a seeded Random face (Distinctiveness `level`) drawn here by the app itself
    if (idn.random) {
      window.__seed(idn.random.seed);
      idn.sliders = F.random.randomFace(F.random.defs(), idn.random.level);
    }
    for (const t of m.targets()) m.set(t, idn.sliders[t] ?? (m.defaults[t] ?? 0), "tween");
    clearAnim();
    const caps = { ...F.limits.updateCaps() };
    const push = (anim, gaze = [0, 0]) => out.push({ family: "anim", id: `${idn.id}|${anim}`, identity: idn.id, anim, weights: snap(), effective: true, gaze, caps });
    push("rest");
    for (const e of quick ? ["happy", "angry", "surprised", "sad"] : emotions) {
      for (const k of quick ? [1] : [0.6, 1]) {
        clearAnim();
        F.emotion.rig.weights[e] = 1;
        F.emotion.rig.intensity = k;
        S.applyEmotion();
        F.limits.updateCaps(); // the emotion cap for this emotion on this face
        push(`emotion:${e}@${k}`);
      }
    }
    clearAnim();
    F.limits.updateCaps();
    for (const b of [0.7, 1]) {
      clearAnim();
      for (const [t, w] of Object.entries(blinkRole)) m.setLayerValue("blink", t, b * w);
      push(`blink@${b}`);
    }
    for (const v of visemeIds) {
      clearAnim();
      S.setSpeechActivity(1);
      // LipSync.tsx at full activation: preset × this face's cap, replacing what the mouth sliders ask for
      for (const [t, w] of Object.entries(S.visemes.visemes[v])) m.setLayerValue("viseme", t, w * S.visemeCap(v) - m.userValue(t));
      push(`viseme:${v}`);
    }
    for (const [yaw, pitch] of [[25, 0], [-25, 0], [0, 20], [0, -15]]) {
      clearAnim();
      const lid = 0.35 * Math.min(1, Math.max(0, pitch) / 20); // IdleLife.tsx lid follow (POSE.lidFollow)
      if (lid) for (const [t, w] of Object.entries(blinkRole)) m.setLayerValue("gaze", t, lid * w);
      push(`gaze:${yaw},${pitch}`, [yaw, pitch]);
    }
    clearAnim();
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}, [one], quick));
states.push(...anim);
console.log(`animation: ${anim.length} states over ${identities.length} identities`);

fs.writeFileSync(path.join(VAL, "stress_states.json"), JSON.stringify({ quick, errors, states }));
console.log(`-> ${path.join(VAL, "stress_states.json")}${errors.length ? `  (${errors.length} page errors)` : ""}`);
await browser.close();
