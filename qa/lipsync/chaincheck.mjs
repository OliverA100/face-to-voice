// node chaincheck.mjs — the chat boost chain (live.ts: gain → compressor → limiter) on a real line, offline: peak and loudness in and out.
import fs from "node:fs";
import { launch } from "./lib.mjs";
const nd = fs.readFileSync(new URL("./out/clips/A-plosive.ndjson", import.meta.url), "utf8");
const pcm = Buffer.concat(nd.split("\n").filter(Boolean).map((l) => Buffer.from(JSON.parse(l).audio_base64 || "", "base64")));
const samples = Array.from(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1), (v) => v / 32768);
const br = await launch({ browser: "chrome", headless: true });
const page = await br.newPage();
await page.goto("about:blank");
for (const [gain, thr, ratio, makeup] of [[1, 0, 1, 1], [4, -30, 12, 2], [4, -30, 12, 2.5], [4, -30, 12, 3]]) {
  const r = await page.evaluate(async (samples, gain, thr, ratio, makeup) => {
    const sr = 24000, ctx = new OfflineAudioContext(1, samples.length, sr);
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource(); src.buffer = buf;
    let node = src;
    if (gain !== 1) {
      const boost = ctx.createGain(); boost.gain.value = gain;
      const sq = ctx.createDynamicsCompressor(); Object.assign(sq, {}); sq.threshold.value = thr; sq.knee.value = 6; sq.ratio.value = ratio; sq.attack.value = 0.003; sq.release.value = 0.15;
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
      const mk = ctx.createGain(); mk.gain.value = makeup;
      // soft clip: linear to 0.8, then rounded off toward 0.98: the output can't clip
      const ws = ctx.createWaveShaper(); const n = 4097, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18)); }
      ws.curve = curve; ws.oversample = "4x";
      src.connect(boost).connect(sq).connect(mk).connect(lim).connect(ws); node = ws;
    }
    node.connect(ctx.destination); src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    let peak = 0, e = 0, n = 0;
    for (const v of out) { peak = Math.max(peak, Math.abs(v)); if (Math.abs(v) > 0.003) { e += v * v; n++; } }
    let clipped = 0, shaped = 0; for (const v of out) { if (Math.abs(v) >= 0.999) clipped++; if (Math.abs(v) > 0.8) shaped++; }
    return { peakDb: +(20 * Math.log10(peak)).toFixed(1), speechRmsDb: +(10 * Math.log10(e / n)).toFixed(1), clipped, roundedOffPct: +(100 * shaped / n).toFixed(2) };
  }, samples, gain, thr, ratio, makeup);
  console.log(gain === 1 ? "plain line                     " : `boost ${gain} thr ${thr} ratio ${ratio} makeup ${makeup}`.padEnd(31), JSON.stringify(r));
}
await br.close();
