/*
 * Per-face shape limits (animCaps visemeCap: 1 = the shape at full strength) over random characters: a re-solved shape
 * that crosses geometry on more faces gets capped more. Compare a build against the live site.
 *
 *   node caps.mjs --url http://localhost:3000/ [--faces 20]
 */
import { clickText, headReady, launch, open, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const url = opt("url", "http://localhost:3000/");
const n = Number(opt("faces", 20));
const br = await launch({ browser: "chrome", headless: true, width: 1200, height: 900 });
const page = await open(br, url + (url.includes("?") ? "&" : "?") + "debug=1");
await headReady(page);
const ids = ["pp", "ppr", "ff", "th", "dd", "ss", "aa", "e", "i", "o", "u", "ll"];
const rows = [];
for (let k = 0; k < n; k++) {
  await clickText(page, /Random character/);
  await sleep(2500);
  await page.evaluate(() => window.__faceToVoice.limits.updateCaps?.());
  await sleep(800);
  rows.push(await page.evaluate((ids) => Object.fromEntries(ids.map((v) => [v, window.__faceToVoice.stress.visemeCap(v)])), ids));
}
await br.close();
const fmt = (v) => {
  const xs = rows.map((r) => r[v]).filter((x) => typeof x === "number");
  const capped = xs.filter((x) => x < 0.999).length;
  return `${v.padEnd(4)} capped on ${String(capped).padStart(2)}/${xs.length} faces, mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)}, min ${Math.min(...xs).toFixed(3)}`;
};
console.log(url);
for (const v of ids) console.log("  " + fmt(v));
