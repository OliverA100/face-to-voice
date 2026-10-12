/**
 * Where a reply's voice starts, on the clock its word timings use (seconds from the reply's first audio sample).
 *
 * The browser pins each reply's words to the voice it hears: it finds the voice's onset in the track and needs to know
 * where that onset is on the words' clock. ElevenLabs' first-word stamp is not it (eleven_v4_turbo stamps the first
 * word 40–100 ms off the voice, and a silent stretch can come first), so the agent measures the onset on the audio it
 * sends, with the browser's own rule (lib/lipsync/live.ts): the first 10 ms block louder than ONSET_RMS.
 */

/** Raw 0..1 RMS of a 10 ms block, as the browser's meter measures it (lib/lipsync/live.ts ONSET_RMS). */
export const ONSET_RMS = 0.01;

export class OnsetMeter {
  /** Seconds from the first sample to the first block louder than ONSET_RMS; null until there is one. */
  onset: number | null = null;
  private samples = 0; // samples (per channel) seen so far
  private block = 0; // samples in the current block
  private energy = 0;

  /** Feed one frame of 16-bit PCM (channels interleaved; the first one is measured). Returns the onset once found. */
  push(data: Int16Array, sampleRate: number, channels = 1): number | null {
    if (this.onset !== null) return this.onset;
    const size = Math.round(sampleRate / 100);
    for (let i = 0; i < data.length; i += channels) {
      const x = data[i] / 32768;
      this.energy += x * x;
      if (++this.block === size) {
        if (Math.sqrt(this.energy / size) > ONSET_RMS) {
          this.onset = (this.samples + i / channels + 1 - size) / sampleRate;
          return this.onset;
        }
        this.block = 0;
        this.energy = 0;
      }
    }
    this.samples += data.length / channels;
    return null;
  }
}

/**
 * The reply's loudness, 10 ms at a time on the words' clock (block k covers k·10 ms …), measured as the browser's meter
 * does. The browser lines it up with what it hears, so the words follow the voice even when the voice reaches it
 * stretched or with gaps (lib/lipsync/live.ts). Each block ends at the sample nearest its 10 ms mark, so at rates that
 * don't divide by 100 (22 050 Hz: 220.5 samples) the blocks stay on the clock instead of drifting (221 each: 23 ms in
 * 10 s).
 */
export class Envelope {
  private n = 0; // samples in the current block
  private seen = 0; // samples measured (per channel)
  private energy = 0;
  /** Blocks finished so far. */
  count = 0;

  /** Feed one frame of 16-bit PCM (the first channel is measured); returns the RMS of each block it finished. */
  push(data: Int16Array, sampleRate: number, channels = 1): number[] {
    const done: number[] = [];
    let end = Math.round(((this.count + 1) * sampleRate) / 100); // the current block's last sample + 1
    for (let i = 0; i < data.length; i += channels) {
      const x = data[i] / 32768;
      this.energy += x * x;
      this.n++;
      if (++this.seen >= end) {
        done.push(Math.sqrt(this.energy / this.n));
        this.count++;
        this.n = 0;
        this.energy = 0;
        end = Math.round(((this.count + 1) * sampleRate) / 100);
      }
    }
    return done;
  }
}
