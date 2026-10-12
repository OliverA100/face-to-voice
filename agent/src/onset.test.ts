import { describe, expect, it } from "vitest";

import { Envelope, ONSET_RMS, OnsetMeter } from "./onset.ts";

/** `seconds` of 16-bit PCM: silence until `at`, then a tone loud enough to count. */
function pcm(seconds: number, at: number, rate: number, channels = 1): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n * channels);
  for (let i = 0; i < n; i++) {
    const v = i / rate >= at ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)) : Math.round(32768 * ONSET_RMS * 0.3);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

describe("the voice's onset on the words' clock", () => {
  it("is the first 10 ms block above the browser's threshold, across frames", () => {
    const rate = 22_050;
    const all = pcm(1, 0.237, rate);
    const m = new OnsetMeter();
    let found: number | null = null;
    for (let i = 0; i < all.length && found === null; i += 441) found = m.push(all.subarray(i, i + 441), rate); // 20 ms frames
    // the block that holds 0.237 s (from 0.23 s) already has 3 ms of the voice: loud enough
    expect(found).toBeCloseTo(0.23, 2);
  });

  it("measures the first channel of interleaved audio, and stays put once found", () => {
    const m = new OnsetMeter();
    expect(m.push(pcm(0.5, 0.1, 24_000, 2), 24_000, 2)).toBeCloseTo(0.1, 2);
    expect(m.push(pcm(0.5, 0, 24_000), 24_000)).toBeCloseTo(0.1, 2);
  });

  it("finds nothing in silence", () => {
    expect(new OnsetMeter().push(pcm(0.3, 1, 24_000), 24_000)).toBeNull();
  });
});

describe("the reply's loudness", () => {
  it("gives one RMS value per 10 ms block, across frames", () => {
    const rate = 24_000;
    const all = pcm(0.5, 0.2, rate);
    const env = new Envelope();
    const out: number[] = [];
    for (let i = 0; i < all.length; i += 480) out.push(...env.push(all.subarray(i, i + 480), rate)); // 20 ms frames
    expect(out).toHaveLength(50);
    expect(env.count).toBe(50);
    expect(out[10]).toBeLessThan(ONSET_RMS); // before the tone
    expect(out[30]).toBeCloseTo(8000 / 32768 / Math.SQRT2, 2); // a sine's RMS
  });

  it("keeps its blocks on the 10 ms marks at a rate that doesn't divide by 100", () => {
    const rate = 22_050; // 220.5 samples per block
    const env = new Envelope();
    const all = new Int16Array(rate * 10); // 10 s
    let blocks = 0;
    for (let i = 0; i < all.length; i += 441) blocks += env.push(all.subarray(i, i + 441), rate).length;
    expect(blocks).toBe(1000); // 221-sample blocks would give 997 (23 ms short)
  });
});
