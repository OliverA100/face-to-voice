/**
 * Streams the NDJSON from /api/voice/speak into Web Audio: each line's PCM becomes an
 * AudioBuffer scheduled gaplessly after the previous one, and each line's alignment becomes
 * viseme cues. The AudioContext clock is the master clock for the mouth (never a JS timer).
 *
 * iOS/Android: the context must be created or resumed inside the tap that starts speech, so
 * call `unlock()` synchronously in the click handler before any await.
 */
import { alignmentToCues, mergeAlignments, type Alignment, type Cue } from "./cues";
import { LIPSYNC_PARTS } from "./tuning";
import { HeardClock } from "./clock";
import { ENVELOPE_RATE, LoudnessEnvelope } from "./envelope";
import { dropOutput, outputOf, restOutput, wakeOutput } from "./output";
import { addPhonemes } from "./phonemes";
import { isAppleTouch, takeLongHide } from "./staleTab";

const SPEECH_FAILED = "The line couldn't be spoken. Please try again.";

const SAMPLE_RATE = ENVELOPE_RATE;
const PRIME_SECONDS = 0.25; // audio buffered before playback starts (raised when chunks arrive slowly)
const LEAD = 0.03; // s between "now" and the first scheduled sample
const RESUME_WAIT_MS = 1000; // how long the first audio waits for a resting context to run (startWhenRunning)
const SYNC_KEY = "ftv-sync-ms"; // localStorage: extra ms the listener's audio path delays the sound
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
  /** The line's times from forced alignment on its audio (the speak route's {"aligned"} line), used over the stamps. */
  private forced: Alignment | null = null;
  private abort: AbortController | null = null;
  private endTimer: ReturnType<typeof setTimeout> | undefined; // watchEnd's: a later line must not be ended by it
  private gotAudio = false; // any audio in this line's stream
  private waiting: object | null = null; // startWhenRunning: the first audio waits for the context to run (this wait)
  private oddByte: number | null = null; // a chunk's last byte when it split a sample: the next chunk starts with it
  private lastSource: AudioBufferSourceNode | null = null; // the line's last scheduled audio
  private onLastEnded: (() => void) | null = null; // watchEnd's: runs when lastSource has played
  cues: Cue[] = [];
  /** The cues are the forced alignment's (evaluator.ts SpeechSource.aligned). */
  get aligned(): boolean {
    return this.forced !== null;
  }
  /** The line's loudness per 10 ms (and above 2 kHz), filled as chunks arrive (envelope.ts). */
  private envelope = new LoudnessEnvelope();
  state: PlayerState = "idle";
  metrics: SpeechMetrics = { tapAt: 0, firstByteMs: null, firstScheduledMs: null, firstAudibleMs: null, underruns: 0, sampleRate: 0, outputLatencyMs: 0 };
  listeners = new Set<() => void>();
  /** Extra seconds the sound takes to reach the listener beyond what the browser can know: a
   *  monitor's HDMI speakers, Bluetooth headphones, a TV. Set once with the Sync control, kept in
   *  localStorage; `?syncMs=` overrides it for this page view only (a link must not change it for
   *  good). Positive = the mouth waits longer for the sound. */
  private syncDelay: number | null = null;
  /** When the listener hears what (clock.ts): the output delay with device corrections, carried smoothly. */
  private clock = new HeardClock(() => this.ctx);

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

  /** Seconds between ctx.currentTime and the sound reaching the listener (clock.ts). */
  private outputLatency(): number {
    return this.clock.latency();
  }

  /** Call synchronously in the user's tap. */
  unlock(): void {
    // an iPhone tab back from a long time in the background can play silently (staleTab.ts): start the audio over
    if (takeLongHide() && this.ctx) {
      dropOutput(this.ctx); // its <audio> element too (output.ts)
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      audioSession("auto"); // asked for again below, so iOS sets the playback session up afresh
    }
    audioSession("playback");
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state !== "running") void this.ctx.resume();
    // the route's <audio> element is made and played here, in the tap (Safari starts media only from a gesture)
    outputOf(this.ctx);
    wakeOutput(this.ctx);
  }

  /**
   * Stop, and on an iPhone or iPad let the audio go entirely (the next Speak makes it again, in its tap): a chat started
   * while a line still played got a context that never ran there (the voice heard through LiveKit's own element, the
   * lips still). Call before the chat's context is resumed.
   */
  release(): void {
    this.stop();
    if (this.ctx && isAppleTouch()) {
      dropOutput(this.ctx);
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  /** Clip time in seconds as the listener hears it (negative before playback starts). */
  time(): number {
    if (!this.ctx || !this.started) return -1;
    const t = this.clock.heard() - this.clipStart - this.syncDelayMs / 1000;
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
    this.waiting = null;
    this.streamEnded = false;
    this.cues = [];
    this.alignments = [];
    this.forced = null;
    this.envelope.reset();
    this.gotAudio = false;
    if (this.state === "playing" || this.state === "loading") this.setState("idle");
  }

  /** Seconds of audio decoded so far (the envelope is valid up to here). */
  decodedSeconds(): number {
    return this.envelope.seconds();
  }

  /** The whole line has arrived and is decoded: nothing more will be added to the envelope. */
  get streamDone(): boolean {
    return this.streamEnded;
  }

  /** 0..1 loudness of the audio at clip time t (0 outside the clip or before it is decoded). */
  loudness(t: number): number {
    return this.envelope.loudness(t);
  }

  /** 0..1 loudness above 2 kHz at clip time t (0 outside the clip or before it is decoded). */
  trebleLoudness(t: number): number {
    return this.envelope.trebleLoudness(t);
  }

  /** Plays the line `fetchResponse` asks for. Its signal aborts on stop() or the next line: pass it to fetch, so a
   *  stopped line stops downloading (the server still finishes and caches it). */
  async speak(fetchResponse: (signal: AbortSignal) => Promise<Response>): Promise<void> {
    this.stop();
    this.unlock();
    const ctx = this.ctx!;
    this.metrics = { tapAt: performance.now(), firstByteMs: null, firstScheduledMs: null, firstAudibleMs: null, underruns: 0, sampleRate: ctx.sampleRate, outputLatencyMs: Math.round(this.outputLatency() * 1000) };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.setState("loading");
    try {
      const res = await fetchResponse(signal);
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw Object.assign(new Error(data.message ?? SPEECH_FAILED), { code: data.error ?? "upstream" }); // the code: a limit links to the limits dialog
      }
      const reader = res.body.getReader();
      signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
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
      if (!this.gotAudio) throw Object.assign(new Error(SPEECH_FAILED), { code: "upstream" }); // a 200 that wasn't the stream (an empty body, a proxy's page)
      this.streamEnded = true;
      if (!this.started) this.startWhenRunning();
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
    let chunk: { audio_base64?: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null; phonemes?: Record<string, string>; aligned?: Alignment | null };
    try {
      chunk = JSON.parse(line);
    } catch {
      return; // a malformed line is skipped; the rest of the clip still plays
    }
    // the line's words as they are said (the speak route's first line): the cues are built from them
    if (chunk.phonemes && typeof chunk.phonemes === "object") {
      addPhonemes(chunk.phonemes);
      this.buildCues();
      return;
    }
    // the whole line's times from forced alignment, before its audio (lib/server/speech.ts; null: it could not be aligned)
    if ("aligned" in chunk) {
      if (chunk.aligned?.characters?.length && LIPSYNC_PARTS.forcedAlignment) {
        this.forced = chunk.aligned;
        this.buildCues();
      }
      return;
    }
    const align = chunk.normalized_alignment ?? chunk.alignment;
    if (align && align.characters?.length) {
      this.alignments.push(align);
      if (!this.forced) this.buildCues();
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
    // loudness envelopes in contiguous 10 ms blocks: the whole sound, and above 2 kHz (envelope.ts)
    this.envelope.push(data);
    if (!this.started) {
      this.pending.push(buffer);
      this.pendingSeconds += buffer.duration;
      if (this.pendingSeconds >= PRIME_SECONDS) this.startWhenRunning();
    } else {
      this.schedule(buffer);
    }
  }

  private buildCues(): void {
    if (this.forced) this.cues = alignmentToCues(this.forced);
    else if (this.alignments.length) this.cues = alignmentToCues(mergeAlignments(this.alignments));
  }

  /**
   * Start once the context runs. It rests between lines (setState) and unlock() resumes it, but Safari played audio
   * scheduled before the resume had finished ~1 s late (a cached line arrives that fast). If it doesn't run within
   * RESUME_WAIT_MS, start anyway.
   */
  private startWhenRunning(): void {
    const ctx = this.ctx!;
    if (ctx.state === "running") return this.start();
    if (this.waiting) return;
    const wait = (this.waiting = {});
    const go = () => {
      if (ctx.state !== "running" && !timedOut && this.waiting === wait) return;
      ctx.removeEventListener("statechange", go);
      clearTimeout(timer);
      if (this.waiting !== wait) return; // stopped, or another line's wait
      this.waiting = null;
      if (this.started) return;
      this.start();
      if (this.streamEnded) this.watchEnd();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      go();
    }, RESUME_WAIT_MS);
    ctx.addEventListener("statechange", go);
    void ctx.resume().catch(() => {});
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
    src.connect(outputOf(ctx)); // Safari: an <audio> element plays it (output.ts)
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
    if (s !== "loading" && s !== "playing") {
      audioSession("auto"); // the line is over: other apps' audio may come back
      // and the context rests until the next Speak (unlock() resumes it in the tap). Safari on a Mac: a
      // context left running with nothing to play, ~10 min in a tab nobody looks at, stuck that tab's audio output at
      // its sample rate (lines came 0.8 s late or silent, reported on time; a new context or a reload at that rate
      // inherited it, only a new tab didn't). Suspended while idle, the same 10 minutes left it on time.
      if (this.ctx?.state === "running") void restOutput(this.ctx).catch(() => {});
    }
    for (const fn of this.listeners) fn();
  }
}

/**
 * iOS (Safari 16.4+): Web Audio follows the ringer's silent switch unless the session says this is playback (the <audio>
 * previews already ignore it, so Speak was the only silent thing). "playback" pauses other apps' audio (music, a
 * podcast), so it is asked for only while a line is loading or playing and handed back ("auto") when it ends.
 * iPhone and iPad only (touch: iPadOS says it is a Mac): on a Mac there is no silent switch, and Safari answered these
 * switches by muting the tab's Web Audio after it had sat in the background a while, until a new tab was opened.
 */
function audioSession(type: "playback" | "auto"): void {
  if (typeof navigator === "undefined" || !("audioSession" in navigator) || !(navigator.maxTouchPoints > 1)) return;
  try {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session.type !== type) session.type = type;
  } catch {
    /* not settable here */
  }
}

export const speechPlayer = new SpeechPlayer();
