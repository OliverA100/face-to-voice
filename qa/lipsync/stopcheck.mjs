/*
 * After Stop: silence, or the route's element looping its last few ms (Safari, 2026-10-15)? A steady tone through the
 * app's player, stopped at 2 s, the Mac's mic recording on. Prints the room's loudness before, during and after.
 *   node stopcheck.mjs [--url http://localhost:3041/?debug=1] [--tag stop]
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { OUT, headReady, launch, open, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const url = opt("url", "http://localhost:3041/?debug=1");
const tag = opt("tag", "stop");
const wav = path.join(OUT, "room", `${tag}.wav`);
const br = await launch({ browser: "safari" });
const page = await open(br, url);
await headReady(page);
execFileSync("osascript", ["-e", 'tell application "Safari" to activate']);
const nd = fs.readFileSync(path.join(OUT, "tone.ndjson"), "utf8");
fs.rmSync(wav, { force: true });
// 8 s of the default mic, 48 kHz mono
const rec = spawn("ffmpeg", ["-v", "error", "-f", "avfoundation", "-i", ":default", "-t", "8", "-ac", "1", "-ar", "48000", wav], { stdio: "ignore" });
const done = new Promise((ok) => rec.on("exit", ok));
await sleep(1500); // quiet before
await page.mouse.click(300, 300);
await page.evaluate(() => window.__faceToVoice.speech.unlock());
await page.evaluate((nd) => window.__faceToVoice.speech.speak(() => Promise.resolve(new Response(nd))), nd);
await sleep(2000);
await page.evaluate(() => window.__faceToVoice.speech.stop()); // at ~3.5 s of the recording
await done;
await br.close();
const py = `
import wave, numpy as np
w = wave.open("${wav}"); x = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(float) / 32768
rms = lambda a, b: float(np.sqrt((x[int(a * 48000):int(b * 48000)] ** 2).mean()))
q, p, after = rms(0.2, 1.3), rms(2.2, 3.2), rms(4.3, 7.8)
print(f"${tag}: room before {q:.4f}  tone {p:.4f}  after Stop {after:.4f}  (after/before {after / q:.1f}x)")`;
console.log(execFileSync("python3", ["-c", py]).toString().trim());
