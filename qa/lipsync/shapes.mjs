/*
 * Contact sheet of the mouth shapes as the app draws them: every viseme preset (visemes.json, capped for the face as
 * LipSync does) held still, from the front, three-quarter and profile, on the default face and a few random
 * characters. Uses the debug handle (?debug): morphs' "viseme" layer, view(), still().
 *
 *   node shapes.mjs [--url http://localhost:3041/] [--faces 3] [--tag shapes] [--emotion Happy]
 *   uv run sheet.py out/shapes/<tag>     → out/shapes/<tag>.jpg
 */
import fs from "node:fs";
import path from "node:path";

import { OUT, clickText, headReady, launch, open, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const url = opt("url", "http://localhost:3041/");
const faces = Number(opt("faces", 3));
const tag = opt("tag", "shapes");
const emotion = opt("emotion", null);
// --presets cands.json --keys u_now,u_round,…: render these weights instead of visemes.json's shapes ("ll*" = a tongue
// pose: drawn with the "d"'s lips)
const presetsFile = opt("presets", null);
const CANDS = presetsFile ? JSON.parse(fs.readFileSync(presetsFile, "utf8")) : null;
const KEYS = opt("keys", null)?.split(",");
const VISEMES = KEYS ?? ["rest", "pp", "ppr", "ff", "th", "dd", "ll", "ss", "aa", "e", "i", "o", "u"];
const VIEWS = {
  front: { target: [0, 0.244, 0.12], yaw: 0, pitch: 0, dist: 0.16 },
  threeQuarter: { target: [0, 0.244, 0.11], yaw: 38, pitch: 0, dist: 0.17 },
  profile: { target: [0.0, 0.244, 0.135], yaw: 90, pitch: 0, dist: 0.17 },
};
const dir = path.join(OUT, "shapes", tag);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const br = await launch({ browser: "chrome", width: 900, height: 900 });
const page = await open(br, url + (url.includes("?") ? "&" : "?") + "debug=1");
await headReady(page);

for (let f = 0; f < faces; f++) {
  if (f > 0) {
    await clickText(page, /Random character/);
    await sleep(3500);
    await page.evaluate(() => window.__faceToVoice.setSkinTone("light"));
  }
  if (emotion) {
    await clickText(page, /^Expression$/);
    await sleep(300);
    await clickText(page, new RegExp(`^${emotion}$`));
  }
  await page.evaluate(() => window.__faceToVoice.still(true));
  await sleep(1500);
  for (const v of VISEMES) {
    await page.evaluate((v, cands) => {
      const F = window.__faceToVoice;
      F.morphs.clearLayer("viseme");
      // as while speaking: the emotion's mouth part steps back (emotion.ts lowerWhileSpeaking); not at rest
      F.stress.setSpeechActivity(v === "rest" ? 0 : 1, v === "pp" || v === "ppr" || v === "ff" ? 1 : 0);
      if (v === "rest") return;
      let preset = F.stress.visemes.visemes[v] ?? {};
      // "ll" is a tongue pose: drawn with the "d"'s lips and jaw
      if (v === "ll" && !cands) preset = { ...Object.fromEntries(Object.entries(F.stress.visemes.visemes.dd).filter(([t]) => !t.startsWith("tongue"))), ...preset };
      let cap = F.stress.visemeCap(v);
      if (cands) {
        const base = v.split("_")[0];
        preset = cands[v];
        if (base === "ll") preset = { ...Object.fromEntries(Object.entries(F.stress.visemes.visemes.dd).filter(([t]) => !t.startsWith("tongue"))), ...preset };
        cap = F.stress.visemeCap(base === "ll" ? "dd" : base);
      }
      for (const [t, w] of Object.entries(preset)) F.morphs.setLayerValue("viseme", t, w * cap);
    }, v, CANDS);
    for (const [name, spec] of Object.entries(VIEWS)) {
      await page.evaluate((s) => window.__faceToVoice.view(s), spec);
      await sleep(250);
      await (await page.$("canvas")).screenshot({ path: path.join(dir, `f${f}-${v}-${name}.png`) });
    }
  }
  await page.evaluate(() => window.__faceToVoice.morphs.clearLayer("viseme"));
}
await page.evaluate(() => window.__faceToVoice.view("reset"));
await br.close();
console.log(dir);
