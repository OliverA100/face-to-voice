/**
 * The voice's loudness, 10 ms at a time, as the mouth reads it: the whole sound, and the part above TREBLE_HZ (where an
 * "m" goes quiet while the lips are shut). Fed with the clip's samples as they arrive; each envelope is normalised by
 * its running peak. Used by the speech player, and by the measuring bench (qa/lipsync) on saved lines.
 */
export const ENVELOPE_RATE = 24000; // the speech stream's PCM rate (ElevenLabs pcm_24000)
/** The treble envelope's high-pass (Hz): an "m" hums on through the nose with the lips shut, so the line's loudness
 *  hardly dips, but nothing above ~2 kHz gets out (placement.ts snapClosures). */
const TREBLE_HZ = 2000;
const TREBLE = (() => {
  // RBJ biquad high-pass, Q = 1/√2, at ENVELOPE_RATE
  const w = (2 * Math.PI * TREBLE_HZ) / ENVELOPE_RATE, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
})();

export class LoudnessEnvelope {
  /** RMS per 10 ms of clip time; normalised by a running peak when read. */
  private env: number[] = [];
  private peak = 0.05;
  private energy = 0; // partial block carried across chunk boundaries
  private count = 0;
  /** The same, above TREBLE_HZ (its own running peak). */
  private treble: number[] = [];
  private treblePeak = 0.01;
  private trebleEnergy = 0;
  private hp = [0, 0, 0, 0]; // the high-pass's x[n−1], x[n−2], y[n−1], y[n−2], carried across chunks

  reset(): void {
    this.env = [];
    this.peak = 0.05;
    this.energy = 0;
    this.count = 0;
    this.treble = [];
    this.treblePeak = 0.01;
    this.trebleEnergy = 0;
    this.hp = [0, 0, 0, 0];
  }

  /** Adds samples (−1..1, ENVELOPE_RATE) in contiguous 10 ms blocks; a partial block carries over to the next call. */
  push(data: ArrayLike<number>): void {
    const block = ENVELOPE_RATE / 100;
    const { b0, b1, b2, a1, a2 } = TREBLE;
    let [x1, x2, y1, y2] = this.hp;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      this.energy += x * x;
      this.trebleEnergy += y * y;
      if (++this.count === block) {
        const rms = Math.sqrt(this.energy / block);
        this.env.push(rms);
        if (rms > this.peak) this.peak = rms;
        const high = Math.sqrt(this.trebleEnergy / block);
        this.treble.push(high);
        if (high > this.treblePeak) this.treblePeak = high;
        this.energy = 0;
        this.trebleEnergy = 0;
        this.count = 0;
      }
    }
    this.hp = [x1, x2, y1, y2];
  }

  /** Seconds of audio measured so far. */
  seconds(): number {
    return this.env.length / 100;
  }

  /** 0..1 loudness at clip time t (0 outside what has been measured). */
  loudness(t: number): number {
    const v = this.env[Math.round(t * 100)];
    return v === undefined ? 0 : Math.min(1, v / this.peak);
  }

  /** 0..1 loudness above TREBLE_HZ at clip time t. */
  trebleLoudness(t: number): number {
    const v = this.treble[Math.round(t * 100)];
    return v === undefined ? 0 : Math.min(1, v / this.treblePeak);
  }
}
