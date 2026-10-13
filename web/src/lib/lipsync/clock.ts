/**
 * When the listener hears what: the AudioContext time of the sound reaching them now, for the speech player and live
 * conversations alike. Measured on real devices (qa/lipsync room.mjs, LIPSYNC_REPORT.md):
 *  - ctx.currentTime − ctx.outputLatency is right to within ~20 ms on built-in speakers in Chrome, Firefox and Safari.
 *    getOutputTimestamp is not a substitute: Firefox's and Safari's leave the output delay out (162 ms off on AirPods).
 *  - Chrome moves currentTime in 10.7 ms steps (512 frames at 48 kHz) while frames come every 8.3 ms: between two
 *    steps the time is carried on performance.now() (at most CARRY), so the mouth doesn't stutter. A clock that
 *    stands still (iOS while the context resumes) still stands still after CARRY.
 *  - Bluetooth: browsers report ~160–170 ms for AirPods, which really take ~245 ms. A reported delay of
 *    BLUETOOTH.reported or more gets BLUETOOTH.extra on top.
 *  - iPhone Safari's sound is heard ~50 ms sooner than its reported delay says: IOS_EXTRA (negative).
 * Safari before outputLatency: the delay comes from getOutputTimestamp, carried forward to now and eased.
 */
export const BLUETOOTH = { reported: 0.1, extra: 0.08 };
/** The corrections and the carry above; off = the clock as it was before 2026-10-13 (`?lipsync=v1`, evaluator.ts). */
export const CLOCK = { fixes: true };
export const IOS_EXTRA = -0.05;
const CARRY = 0.012; // s: a little more than one 10.7 ms step

const isIOS = () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 1 && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

export class HeardClock {
  private latencyEst: number | null = null; // Safari without outputLatency: eased estimate from getOutputTimestamp
  private lastRaw = NaN; // ctx.currentTime as last read
  private rawSince = 0; // performance.now() when it last changed
  private ios: boolean | null = null;

  constructor(private readonly ctxOf: () => AudioContext | null) {}

  /** Seconds between ctx.currentTime and the sound reaching the listener, with the device corrections. */
  latency(): number {
    const ctx = this.ctxOf();
    if (!ctx) return 0;
    let l = 0;
    if (ctx.outputLatency > 0) l = ctx.outputLatency;
    else if (typeof ctx.getOutputTimestamp === "function") {
      // Safari has no outputLatency; getOutputTimestamp says which context time was playing at `performanceTime`. The
      // timestamp can be old (Safari refreshes it rarely, e.g. after the window comes back from the background), so it
      // is carried forward to now; otherwise its age would count as output delay and the mouth would run late by it.
      const ts = ctx.getOutputTimestamp();
      if (typeof ts.contextTime === "number" && ts.contextTime > 0 && typeof ts.performanceTime === "number" && ts.performanceTime > 0) {
        const playing = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        const est = Math.max(0, Math.min(0.5, ctx.currentTime - playing));
        this.latencyEst = this.latencyEst === null ? est : this.latencyEst + (est - this.latencyEst) * 0.1;
      }
      l = this.latencyEst ?? 0;
    }
    if (CLOCK.fixes && l >= BLUETOOTH.reported) l += BLUETOOTH.extra;
    if (CLOCK.fixes && (this.ios ??= isIOS())) l += IOS_EXTRA;
    return Math.max(0, l);
  }

  /** The context time being heard now. */
  heard(): number {
    const ctx = this.ctxOf();
    if (!ctx) return 0;
    const now = performance.now();
    const raw = ctx.currentTime;
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.rawSince = now;
    }
    return raw + (CLOCK.fixes ? Math.min(CARRY, Math.max(0, (now - this.rawSince) / 1000)) : 0) - this.latency();
  }

  reset(): void {
    this.lastRaw = NaN;
  }
}
