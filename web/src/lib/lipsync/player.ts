/**
 * Streams the NDJSON from /api/voice/speak into Web Audio: each line's PCM becomes an
 * AudioBuffer scheduled gaplessly after the previous one, and each line's alignment becomes
 * viseme cues. The AudioContext clock is the master clock for the mouth (never a JS timer).
 *
 * iOS/Android: the context must be created or resumed inside the tap that starts speech, so
 * call `unlock()` synchronously in the click handler before any await.
 */
import { alignmentToCues, mergeAlignments, type Alignment, type Cue } from "./cues";

const SAMPLE_RATE = 24000;
const PRIME_SECONDS = 0.25; // audio buffered before playback starts (raised when chunks arrive slowly)
const LEAD = 0.03; // s between "now" and the first scheduled sample
const SYNC_KEY = "ftv-sync-ms"; // localStorage: extra ms the listener's audio path delays the sound
/** The treble envelope's high-pass (Hz): an "m" hums on through the nose with the lips shut, so the line's loudness
 *  hardly dips, but nothing above ~2 kHz gets out (lipsync/evaluator.ts snapClosures). */
const TREBLE_HZ = 2000;
const TREBLE = (() => {
  // RBJ biquad high-pass, Q = 1/√2, at SAMPLE_RATE
  const w = (2 * Math.PI * TREBLE_HZ) / SAMPLE_RATE, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
})();
const syncSeconds = (ms: number) => Math.max(-300, Math.min(500, ms)) / 1000;

/** Safari 16.4+: the page's audio session (not in TypeScript's DOM types yet). */
type AudioSessionNavigator = Navigator & { audioSession: { type: string } };

export interface SpeechMetrics {
  tapAt: number;
  firstByteMs: number | null;
  firstScheduledMs: number | null;
  firstAudibleMs: number | null;
  underruns: number;
  sampleRate: number;
  outputLatencyMs: number;
}

export type PlayerState = "idle" | "loading" | "playing" | "done" | "error";

class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private clipStart = 0; // ctx time at which clip time 0 plays
  private nextTime = 0; // ctx time the next chunk should start
  private pending: AudioBuffer[] = [];
  private pendingSeconds = 0;
  private started = false;
  private streamEnded = false;
  private sources = new Set<AudioBufferSourceNode>();
  private alignments: Alignment[] = [];
  private abort: AbortController | null = null;
  private endTimer: ReturnType<typeof setTimeout> | undefined; // watchEnd's: a later line must not be ended by it
  private gotAudio = false; // any audio in this line's stream
  private oddByte: number | null = null; // a chunk's last byte when it split a sample: the next chunk starts with it
  private lastSource: AudioBufferSourceNode | null = null; // the line's last scheduled audio
  private onLastEnded: (() => void) | null = null; // watchEnd's: runs when lastSource has played
  cues: Cue[] = [];
  /** RMS loudness per 10 ms of clip time, filled as chunks arrive; normalised by a running peak. */
  private envelope: number[] = [];
  private envelopePeak = 0.05;
  private blockEnergy = 0; // partial block carried across chunk boundaries
  private blockCount = 0;
  /** The same, above TREBLE_HZ (normalised by its own running peak): where the lips shut on an "m". */
  private treble: number[] = [];
  private treblePeak = 0.01;
  private trebleEnergy = 0;
  private hp = [0, 0, 0, 0]; // the high-pass's x[n−1], x[n−2], y[n−1], y[n−2], carried across chunks
  state: PlayerState = "idle";
  metrics: SpeechMetrics = { tapAt: 0, firstByteMs: null, firstScheduledMs: null, firstAudibleMs: null, underruns: 0, sampleRate: 0, outputLatencyMs: 0 };
  listeners = new Set<() => void>();
  /** Extra seconds the sound takes to reach the listener beyond what the browser can know: a
   *  monitor's HDMI speakers, Bluetooth headphones, a TV. Set once with the Sync control, kept in
   *  localStorage; `?syncMs=` overrides it for this page view only (a link must not change it for
   *  good). Positive = the mouth waits longer for the sound. */
  private syncDelay: number | null = null;
  private latencyEst: number | null = null; // eased Safari output-latency estimate (outputLatency)

  get syncDelayMs(): number {
    if (this.syncDelay === null) {
      this.syncDelay = 0;
      if (typeof window !== "undefined") {
        try {
          const fromUrl = new URLSearchParams(window.location.search).get("syncMs");
          const raw = fromUrl ?? window.localStorage.getItem(SYNC_KEY);
          if (raw !== null && Number.isFinite(Number(raw))) this.syncDelay = syncSeconds(Number(raw));
        } catch {
          /* private mode: no persistence */
        }
      }
    }
    return Math.round(this.syncDelay * 1000);
  }

  set syncDelayMs(ms: number) {
    this.syncDelay = syncSeconds(ms);
    try {
      window.localStorage.setItem(SYNC_KEY, String(Math.round(this.syncDelay * 1000)));
    } catch {
      /* private mode: no persistence */
    }
  }

  /** Seconds between ctx.currentTime and the sound leaving the audio device, as the browser reports it. */
  private outputLatency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.outputLatency > 0) return ctx.outputLatency;
    // Safari has no outputLatency; getOutputTimestamp says which context time was playing at `performanceTime`. The
    // timestamp can be old (Safari refreshes it rarely, e.g. after the window comes back from the background), so it is
    // carried forward to now; otherwise its age would count as output delay and the mouth would run late by it.
    if (typeof ctx.getOutputTimestamp === "function") {
      const ts = ctx.getOutputTimestamp();
      if (typeof ts.contextTime === "number" && ts.contextTime > 0 && typeof ts.performanceTime === "number" && ts.performanceTime > 0) {
        const playing = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        const est = Math.max(0, Math.min(0.5, ctx.currentTime - playing));
        // read every frame and slightly jittery: ease it
        this.latencyEst = this.latencyEst === null ? est : this.latencyEst + (est - this.latencyEst) * 0.1;
        return this.latencyEst;
      }
    }
    return 0;
  }

  /** Call synchronously in the user's tap. */
  unlock(): void {
    audioSession("playback");
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  /** Clip time in seconds as the listener hears it (negative before playback starts). */
  time(): number {
    if (!this.ctx || !this.started) return -1;
    const t = this.ctx.currentTime - this.clipStart - this.outputLatency() - this.syncDelayMs / 1000;
    if (t >= 0 && this.metrics.firstAudibleMs === null) {
      // Measured, not estimated: the browser only reports its output latency once audio flows.
      this.metrics.firstAudibleMs = Math.round(performance.now() - this.metrics.tapAt);
      this.metrics.outputLatencyMs = Math.round(this.outputLatency() * 1000);
    }
    return t;
  }

  get playing(): boolean {
    return this.state === "playing";
  }

  stop(): void {
    this.abort?.abort();
    clearTimeout(this.endTimer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.lastSource = null;
    this.onLastEnded = null;
    this.oddByte = null;
    this.pending = [];
    this.pendingSeconds = 0;
    this.started = false;
    this.streamEnded = false;
    this.cues = [];
    this.alignments = [];
    this.envelope = [];
    this.envelopePeak = 0.05;
    this.blockEnergy = 0;
    this.blockCount = 0;
    this.treble = [];
    this.treblePeak = 0.01;
    this.trebleEnergy = 0;
    this.hp = [0, 0, 0, 0];
    this.gotAudio = false;
    if (this.state === "playing" || this.state === "loading") this.setState("idle");
  }

  /** Seconds of audio decoded so far (the envelope is valid up to here). */
  decodedSeconds(): number {
    return this.envelope.length / 100;
  }

  /** The whole line has arrived and is decoded: nothing more will be added to the envelope. */
  get streamDone(): boolean {
    return this.streamEnded;
  }

  /** 0..1 loudness of the audio at clip time t (0 outside the clip or before it is decoded). */
  loudness(t: number): number {
    const i = Math.round(t * 100);
    const v = this.envelope[i];
    if (v === undefined) return 0;
    return Math.min(1, v / this.envelopePeak);
  }

  /** 0..1 loudness above TREBLE_HZ at clip time t (0 outside the clip or before it is decoded). */
  trebleLoudness(t: number): number {
    const v = this.treble[Math.round(t * 100)];
    if (v === undefined) return 0;
    return Math.min(1, v / this.treblePeak);
  }

  async speak(fetchResponse: () => Promise<Response>): Promise<void> {
    this.stop();
    this.unlock();
    const ctx = this.ctx!;
    this.metrics = { tapAt: performance.now(), firstByteMs: null, firstScheduledMs: null, firstAudibleMs: null, underruns: 0, sampleRate: ctx.sampleRate, outputLatencyMs: Math.round(this.outputLatency() * 1000) };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.setState("loading");
    try {
      const res = await fetchResponse();
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? "Speech failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) return;
        if (value) {
          if (this.metrics.firstByteMs === null) this.metrics.firstByteMs = Math.round(performance.now() - this.metrics.tapAt);
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) this.handleLine(line);
          }
        }
        if (done) break;
      }
      if (buffer.trim()) this.handleLine(buffer.trim());
      if (!this.gotAudio) throw new Error("Speech failed"); // a 200 that wasn't the stream (an empty body, a proxy's page)
      this.streamEnded = true;
      if (!this.started) this.start();
      this.watchEnd();
    } catch (e) {
      if (signal.aborted) return;
      console.warn("[speech]", e instanceof Error ? e.message : e);
      this.stop(); // the audio already scheduled too: in "error" there is no Stop button and the mouth is still
      this.setState("error");
      throw e;
    }
  }

  private handleLine(line: string): void {
    const ctx = this.ctx!;
    let chunk: { audio_base64?: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null };
    try {
      chunk = JSON.parse(line);
    } catch {
      return; // a malformed line is skipped; the rest of the clip still plays
    }
    const align = chunk.normalized_alignment ?? chunk.alignment;
    if (align && align.characters?.length) {
      this.alignments.push(align);
      this.cues = alignmentToCues(mergeAlignments(this.alignments));
    }
    if (!chunk.audio_base64) return;
    this.gotAudio = true;
    // 16-bit samples, but a chunk can end half way through one: its last byte goes in front of the next chunk.
    const odd = this.oddByte === null ? 0 : 1;
    const text = atob(chunk.audio_base64);
    const bytes = new Uint8Array(odd + text.length);
    if (odd) bytes[0] = this.oddByte!;
    for (let i = 0; i < text.length; i++) bytes[odd + i] = text.charCodeAt(i);
    this.oddByte = bytes.length % 2 ? bytes[bytes.length - 1] : null;
    if (bytes.length < 2) return; // no whole sample yet (an empty buffer would throw)
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
    // Loudness envelopes in contiguous 10 ms blocks (partial blocks carry over to the next chunk): the whole sound, and
    // above TREBLE_HZ.
    const block = SAMPLE_RATE / 100;
    const { b0, b1, b2, a1, a2 } = TREBLE;
    let [x1, x2, y1, y2] = this.hp;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      this.blockEnergy += x * x;
      this.trebleEnergy += y * y;
      if (++this.blockCount === block) {
        const rms = Math.sqrt(this.blockEnergy / block);
        this.envelope.push(rms);
        if (rms > this.envelopePeak) this.envelopePeak = rms;
        const high = Math.sqrt(this.trebleEnergy / block);
        this.treble.push(high);
        if (high > this.treblePeak) this.treblePeak = high;
        this.blockEnergy = 0;
        this.trebleEnergy = 0;
        this.blockCount = 0;
      }
    }
    this.hp = [x1, x2, y1, y2];
    if (!this.started) {
      this.pending.push(buffer);
      this.pendingSeconds += buffer.duration;
      if (this.pendingSeconds >= PRIME_SECONDS) this.start();
    } else {
      this.schedule(buffer);
    }
  }

  private start(): void {
    const ctx = this.ctx!;
    this.started = true;
    this.clipStart = ctx.currentTime + LEAD;
    this.nextTime = this.clipStart;
    for (const b of this.pending) this.schedule(b);
    this.pending = [];
    this.pendingSeconds = 0;
    this.metrics.firstScheduledMs = Math.round(performance.now() - this.metrics.tapAt);
    this.setState("playing");
  }

  private schedule(buffer: AudioBuffer): void {
    const ctx = this.ctx!;
    if (this.nextTime < ctx.currentTime) {
      // Underrun: the network fell behind. Shift the whole clip so cues stay aligned.
      const gap = ctx.currentTime + LEAD - this.nextTime;
      this.clipStart += gap;
      this.nextTime += gap;
      this.metrics.underruns++;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(this.nextTime);
    src.onended = () => {
      this.sources.delete(src);
      if (src === this.lastSource && this.onLastEnded) this.onLastEnded();
    };
    this.sources.add(src);
    this.lastSource = src;
    this.nextTime += buffer.duration;
  }

  /** The line is done once its last audio has played (the source's own `ended`, not a timer from ctx.currentTime: on
   *  iOS the clock can stand still while the context resumes or is interrupted, and the sound then comes later), plus
   *  the output latency and sync delay for it to reach the listener. stop() drops the hook and the timer, so an
   *  earlier line's `ended` (stop() fires it too) never ends a later one. */
  private watchEnd(): void {
    clearTimeout(this.endTimer);
    const finish = () => {
      this.onLastEnded = null;
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => {
        if (this.streamEnded && this.state === "playing") this.setState("done");
      }, (this.outputLatency() + this.syncDelayMs / 1000 + 0.1) * 1000);
    };
    if (this.lastSource && this.sources.has(this.lastSource)) this.onLastEnded = finish;
    else finish(); // already played
  }

  private setState(s: PlayerState): void {
    this.state = s;
    if (s !== "loading" && s !== "playing") audioSession("auto"); // the line is over: other apps' audio may come back
    for (const fn of this.listeners) fn();
  }
}

/**
 * iOS (Safari 16.4+): Web Audio follows the ringer's silent switch unless the session says this is playback (the <audio>
 * previews already ignore it, so Speak was the only silent thing). "playback" pauses other apps' audio (music, a
 * podcast), so it is asked for only while a line is loading or playing and handed back ("auto") when it ends.
 */
function audioSession(type: "playback" | "auto"): void {
  if (typeof navigator === "undefined" || !("audioSession" in navigator)) return;
  try {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session.type !== type) session.type = type;
  } catch {
    /* not settable here */
  }
}

export const speechPlayer = new SpeechPlayer();
