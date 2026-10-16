/**
 * The mouth during a live conversation: the character's voice arrives as a WebRTC track, with no whole line decoded
 * ahead as the speech player has. What the evaluator gets instead (measured against the player on recorded v4 clips:
 * 55 of 63 p/b/m closures where today's lip sync puts them, ~33 ms apart on average, jaw error 0.11):
 *
 *   - word timings ahead of the audio: the agent forwards ElevenLabs' word timings ("ftv.words") as the voice is made,
 *     before it is played, so cues exist before their sounds arrive;
 *   - the loudness and treble envelopes the player computes (same 10 ms blocks, same 2 kHz high-pass), measured on the
 *     track by an AudioWorklet. The voice plays through the meter's own graph (`playThrough`, the element muted),
 *     held back LIVE.delay, so the meter runs that far ahead of what is heard, plus the output latency, as it does
 *     on a decoded line: played from livekit-client's element instead, the meter heard each sound only after it had
 *     been played (Chrome's MediaStreamSource buffers; Safari's element drifts while the microphone is on), and the
 *     mouth ran behind (Chrome and Safari, 2026-10-11). The delay to the speakers comes from the heard clock the
 *     speech player uses too (clock.ts).
 *
 * Each reply is one "line" to the evaluator, pinned to the voice it hears: the voice's onset here is where the agent
 * measured it on the words' clock (agent/src/onset.ts, the same rule as ONSET_RMS). Not the first word's stamp: v4 Turbo
 * stamps it 40–100 ms off the voice, and pinned there every word ran that much late (2026-10-11). Until the
 * agent's onset arrives, the first word stands in.
 *
 * The agent also sends the reply's loudness as it made it (its own audio, on the words' clock). Two things come of it:
 *   - the line follows the voice: what is heard is matched against it as it plays and time 0 eases onto the match, so
 *     an onset pinned off (a click before the voice: 270 ms) or the network's slow creep (~30 ms over 15 s) is caught;
 *   - each phrase starts on its sound (anchors): v4 Turbo's live word stamps come from the text, and a phrase after a
 *     pause can start off its sound ("Someone" 330 ms late, 2026-10-11). Where the voice comes back in the agent's audio,
 *     the stamped word start nearest to it moves onto it, with the words after it, up to the next such place (the
 *     stamps don't always leave a gap where the voice pauses). Found in what is heard instead, a breath or a click read
 *     as the voice coming back, and each wrong anchor carried into the next: a greeting's last words ran a second early.
 */
import { HeardClock } from "./clock";
import { outputOf } from "./output";
import { alignmentToCues, type Alignment, type Cue } from "./cues";
import { queuePhonemes, spokenWords } from "./phonemes";
import { LIPSYNC, LIPSYNC_PARTS, type SpeechSource } from "./evaluator";
import { speechPlayer } from "./player";

/** One word as the agent sends it: text, and seconds from the start of the reply's audio. */
export interface LiveWord {
  w: string;
  s: number;
  e: number;
}

/** A reply's voice starts here (raw 0..1 RMS): above the codec's noise floor, below the quietest first syllable. The
 *  agent measures its side with the same value (agent/src/onset.ts). */
const ONSET_RMS = 0.01;
const LETTER = /[\p{L}\p{N}]/u;
/** A pause: this long (s) under ONSET_RMS. The voice coming back after one starts a phrase … */
const PAUSE_SECONDS = 0.1;
/** … if it then lasts this long (s), pauses under PAUSE_SECONDS bridged: a breath or a click is shorter. */
const PHRASE_MIN = 0.15;
/** A phrase start in the agent's audio takes the stamped word start nearest to it, within this (s). */
const PHRASE_SEARCH = 0.4;
/** A word stamped into the pause before it (the voice comes back after its stamped start, before ACROSS_LATE past its
 *  stamped end) starts where the voice comes back, and lasts at least ACROSS_MIN (s). */
const ACROSS_LATE = 0.1;
const ACROSS_MIN = 0.08;
/** A word ending like this is followed by a pause in the speech (a full stop, a comma, a dash). */
const PAUSE_AFTER = /[.,!?;:…—–-]["')\]]*\s*$/;
/** Matching what is heard against the agent's audio: the window (s), how far from the current fit it looks (s), the
 *  correlation it needs, and how far time 0 may move per match (s, so a correction eases in). */
const FOLLOW = { window: 1.5, search: 0.3, corr: 0.85, step: 0.04, every: 25 };
/**
 * The voice is held back this long (s) before it plays, so the lip sync sees each sound ahead of the listener, as it
 * does a recorded line (decoded before it plays): its gate reads ~60 ms ahead and the mouth runs LIPSYNC.lead ahead.
 * Replies start that much later.
 */
export const LIVE = { delay: 0.13 }; // how far the meter runs ahead of what is heard: the gate's ~60 ms look-ahead, the closures' ~90 ms anticipation

/** How far past the last measured block (10 ms blocks) its level holds. */
const HOLD_BLOCKS = 8;
/** After a reply ends, the mouth keeps following the sound this long (the last syllable, the room's latency). */
const TAIL_SECONDS = 0.6;
/** The agent says a reply ended when it has sent the last of it; it reaches the meter up to this long (s) later. */
const ARRIVAL_SECONDS = 0.25;

// The meter, as an AudioWorklet: 10 ms blocks of RMS, all of it and above 2 kHz (RBJ high-pass, Q 1/√2), as the
// speech player computes them; each block is posted with the context time of its first sample.
/** 10 ms meter blocks sent to the page together (40 ms: well inside LIVE.delay's 130 ms of look-ahead). */
const METER_BATCH = 4;
const WORKLET = `
class FtvMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate / 100);
    this.n = 0; this.e = 0; this.h = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    const w = (2 * Math.PI * 2000) / sampleRate, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
    this.c = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
    this.done = false;
    // finished blocks wait here and go to the page BATCH at a time: nothing is allocated per render quantum (every
    // 2.7 ms), and few messages are posted. An array made in every process() and a message per 10 ms block made garbage
    // on the audio thread, and an iPhone's chats popped (Speak, with no worklet, didn't: 2026-10-16)
    this.out = new Float64Array(3 * ${METER_BATCH});
    this.k = 0;
    this.port.onmessage = () => (this.done = true); // the chat ended: let the node go
  }
  process(inputs) {
    if (this.done) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const c = this.c;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i], y = c[0] * x + c[1] * this.x1 + c[2] * this.x2 - c[3] * this.y1 - c[4] * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      this.e += x * x; this.h += y * y;
      if (++this.n === this.block) {
        const j = 3 * this.k++;
        this.out[j] = (currentFrame + i + 1 - this.block) / sampleRate;
        this.out[j + 1] = Math.sqrt(this.e / this.block);
        this.out[j + 2] = Math.sqrt(this.h / this.block);
        this.n = 0; this.e = 0; this.h = 0;
        if (this.k === ${METER_BATCH}) {
          this.port.postMessage(this.out);
          this.k = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("ftv-meter", FtvMeter);
`;

/** Contexts the meter's processor is registered in (or being registered in). */
const metered = new WeakMap<BaseAudioContext, Promise<void>>();

export class LiveSpeech implements SpeechSource {
  cues: Cue[] = [];
  get gateLookahead(): number {
    return LIPSYNC.liveGateLookahead;
  }
  private readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private delay = 0; // s the voice is held back before it plays (playThrough), so the meter runs that far ahead
  // the envelopes, one value per 10 ms from t0 (context seconds)
  private t0 = NaN;
  private env: number[] = [];
  private tre: number[] = [];
  private peak = 0.05;
  private treblePeak = 0.01;
  // the current reply
  private lineAt = NaN; // context time of the reply's time 0
  private onsetAt = NaN; // context time its voice started
  private words: LiveWord[] = [];
  private wordsOnset = NaN; // where the voice starts on the words' clock, as the agent measured it
  private anchors: { from: number; to: number; shift: number; start?: number }[] = []; // words from..to-1 move by `shift` (s); `start`: word `from` starts there
  private follow = 0; // s added to time 0: the voice as heard, matched against the agent's audio
  private sinceFollow = 0; // blocks measured since the last match
  private replying = false;
  private endedAt = NaN;
  private clock: HeardClock;
  private detached = false;
  private wordsCame = false; // a words stream opened since the last reply started
  private sent: number[] = []; // the reply's loudness as the agent sent it (RMS, 10 ms blocks on the words' clock)

  /** Phrases are placed here, on the agent's audio (anchors), not by the evaluator's placePhrases. */
  readonly phrasesPlaced = true;

  /** Where the voice starts on the line's clock (the words'), as the agent measured it on its audio: placeLine needs
   *  no look-ahead to put the first word there (it waited for ~0.5 s of heard audio, and "Honestly" stayed on its stamp
   *  0.3 s after the voice had started: user review 10-15). */
  get voiceStart(): number | undefined {
    if (!LIPSYNC_PARTS.liveVoiceStart || !this.sent.length) return undefined;
    // placeLine's own rule (LIPSYNC.lineOnsetDb under the loudest moment), on the agent's audio (the words' clock)
    let peak = 0;
    for (const v of this.sent) if (v > peak) peak = v;
    const level = peak * Math.pow(10, LIPSYNC.lineOnsetDb / 20);
    const k = this.sent.findIndex((v) => v > level);
    return peak > 0 && k >= 0 ? k / 100 : undefined;
  }

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.clock = new HeardClock(() => this.ctx);
  }

  /**
   * Start measuring the character's voice. `playThrough`: also play it from here, held back LIVE.delay, instead of from
   * livekit-client's element, so the sound and the meter share one clock and the lip sync can look ahead.
   */
  async attach(track: MediaStreamTrack, playThrough = false, delaySeconds = LIVE.delay, gain = 1): Promise<void> {
    // once per context: a context serves every chat (TalkPanel), and registering the processor twice throws
    let ready = metered.get(this.ctx);
    if (!ready) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      ready = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      ready.catch(() => metered.delete(this.ctx)); // a failed load is tried again by the next chat
      metered.set(this.ctx, ready);
    }
    await ready;
    if (this.detached) return; // the chat ended while the meter loaded
    // not running when the voice arrives (an iPhone left it suspended): asked again; with the mic on, iOS allows it
    // without a tap
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    this.disconnect(); // the track again (a reconnect): one graph at a time
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    // `?talkMeter=off` (a test: chats popped on an iPhone): no meter, the voice only, so the mouth stays still
    if (new URLSearchParams(location.search).get("talkMeter") !== "off") {
      this.node = new AudioWorkletNode(this.ctx, "ftv-meter", { numberOfOutputs: 1, outputChannelCount: [1] });
      this.node.port.onmessage = (e: MessageEvent<ArrayLike<number>>) => this.blocks(e.data);
      this.source.connect(this.node);
      // pulled by the graph (a node with no route to the output may not run); it writes nothing, so it is silent
      this.node.connect(outputOf(this.ctx));
    }
    // `gain`: the voice made louder (session.ts chatBoost), a limiter after it so loud words don't clip
    let out: AudioNode = outputOf(this.ctx);
    if (playThrough && gain !== 1) {
      const boost = this.ctx.createGain();
      boost.gain.value = gain;
      const limit = this.ctx.createDynamicsCompressor();
      limit.threshold.value = -1; // just under full scale: as loud as it can go without clipping
      limit.knee.value = 3;
      limit.ratio.value = 20;
      limit.attack.value = 0.002;
      limit.release.value = 0.1;
      boost.connect(limit).connect(out);
      out = boost;
    }
    if (playThrough && delaySeconds > 0) {
      // held back: the meter sees each sound this long before it is heard (the gates and loudness read ahead; the
      // evaluator's closure and vowel snapping need more look-ahead than this, so live they mostly settle after the fact)
      const hold = this.ctx.createDelay(1);
      hold.delayTime.value = delaySeconds;
      this.source.connect(hold).connect(out); // Safari: through an <audio> element (output.ts)
      this.delay = delaySeconds;
    } else if (playThrough) this.source.connect(out);
  }

  detach(): void {
    this.detached = true;
    this.disconnect();
  }

  private disconnect(): void {
    this.source?.disconnect();
    this.node?.port.postMessage("stop");
    this.node?.disconnect();
    this.node = this.source = null;
  }

  private blocks(data: ArrayLike<number>) {
    for (let i = 0; i < data.length; i += 3) {
      const [at, rms, high] = [data[i], data[i + 1], data[i + 2]];
      if (Number.isNaN(this.t0)) this.t0 = at;
      const k = Math.round((at - this.t0) * 100);
      while (this.env.length < k) {
        // a gap (blocks that came late or not at all): silence
        this.env.push(0);
        this.tre.push(0);
      }
      this.env[k] = rms;
      this.tre[k] = high;
      if (this.replying) {
        if (Number.isNaN(this.onsetAt) && rms > ONSET_RMS) {
          this.onsetAt = at;
          this.place();
        }
        // normalised by the loudest moment of this reply so far, as the player does over a line
        if (!Number.isNaN(this.onsetAt)) {
          if (rms > this.peak) this.peak = rms;
          if (high > this.treblePeak) this.treblePeak = high;
        }
      }
    }
    if (this.replying && (this.sinceFollow += data.length / 3) >= FOLLOW.every) {
      this.sinceFollow = 0;
      this.followVoice();
    }
  }

  /** Time 0 eases onto where what is heard matches the agent's audio best (log loudness, the last FOLLOW.window s). */
  private followVoice() {
    if (Number.isNaN(this.lineAt) || !this.sent.length || !this.words.length) return;
    const n = FOLLOW.window * 100;
    const reach = FOLLOW.search * 100;
    // the window's end (heard blocks): sent already, and room after it to look later by `reach`
    const end = Math.min(this.env.length - reach, Math.round((this.lineAt + this.sent.length / 100 - this.t0) * 100));
    const j0 = Math.round((this.t0 + (end - n) / 100 - this.lineAt) * 100); // the window's start on the words' clock
    if (end - n < 0 || j0 < 0) return;
    const sent = this.sent.slice(j0, j0 + n);
    if (sent.length < n || sent.filter((v) => v > ONSET_RMS).length < n * 0.3) return; // mostly a pause: nothing to match
    const db = (v: number | undefined) => 20 * Math.log10(Math.max(v ?? 0, 1e-4));
    const a = sent.map(db);
    const lo = Math.max(0, end - n - reach);
    const heard = this.env.slice(lo, end + reach).map(db); // every lag's window, in dB once
    let best = 0, bestCorr = -1;
    // nearest first: a farther match must be clearly better (a steady rhythm of syllables matches one syllable over too)
    for (let d = 0; d <= reach; d++) {
      for (const lag of d ? [-d, d] : [0]) {
        const from = end - n + lag - lo;
        if (from < 0 || from + n > heard.length) continue;
        const c = correlation(a, heard.slice(from, from + n));
        if (c > bestCorr + 0.01) [best, bestCorr] = [lag, c];
      }
    }
    if (bestCorr < FOLLOW.corr || !best) return;
    this.follow += Math.max(-FOLLOW.step, Math.min(FOLLOW.step, best / 100));
    // the cues again: the evaluator's audio snapping was worked out on the old time 0, and is done again on the new one
    this.place();
  }

  /** Time 0 as the onsets put it: the voice's here, less where it starts on the words' clock (or the first word). */
  private pin(): number {
    return this.onsetAt - (Number.isNaN(this.wordsOnset) ? this.words[0].s : this.wordsOnset);
  }

  /**
   * Phrase starts in the agent's own audio (s on the words' clock): the voice back after PAUSE_SECONDS, for at least
   * PHRASE_MIN (a phrase still being sent counts once it has lasted that long).
   */
  private sentPhrases(): number[] {
    const out: number[] = [];
    const loud = (i: number) => (this.sent[i] ?? 0) > ONSET_RMS;
    let quiet = 0;
    let voiced = false; // the reply's first sound is its onset (time 0's pin), not a phrase start
    for (let i = 0; i < this.sent.length; i++) {
      if (!loud(i)) {
        quiet++;
        continue;
      }
      if (quiet >= PAUSE_SECONDS * 100 && voiced) {
        // how long it lasts (to its last loud block), short gaps bridged
        let last = i;
        for (let j = i; j < this.sent.length && j - last <= PAUSE_SECONDS * 100; j++) if (loud(j)) last = j;
        if (last + 1 - i >= PHRASE_MIN * 100) out.push(i / 100);
      }
      voiced = true;
      quiet = 0;
    }
    return out;
  }

  /** Where the voice comes back in the agent's audio, the nearest stamped word start moves onto it (in order). */
  private findAnchors() {
    const anchors: { from: number; to: number; shift: number; start?: number }[] = [];
    let next = 1; // the first word is time 0's pin
    for (const at of this.sentPhrases()) {
      // a word stamped across the voice's return, after a pause in the text, took the pause into its stamp ("hey. I":
      // "I" stamped from 1.00 to 1.40 s, said from 1.36): it starts where the voice comes back, and the words after it
      // keep their stamps (the nearest stamped start was "was", and the phrase moved 0.12 s early: user review 10-15)
      const across = LIPSYNC_PARTS.liveAcross ? this.words.findIndex((w, i) => i >= next && w.s < at && at < w.e + ACROSS_LATE && PAUSE_AFTER.test(this.words[i - 1].w) && this.words[i - 1].e <= at) : -1;
      if (across >= 0) {
        if (anchors.length) anchors[anchors.length - 1].to = across;
        anchors.push({ from: across, to: this.words.length, shift: 0, start: at });
        next = across + 1;
        continue;
      }
      let best = -1;
      for (let i = next; i < this.words.length && this.words[i].s < at + PHRASE_SEARCH; i++) {
        const off = Math.abs(this.words[i].s - at);
        if (off < PHRASE_SEARCH && (best < 0 || off < Math.abs(this.words[best].s - at))) best = i;
      }
      if (best < 0) continue;
      if (anchors.length) anchors[anchors.length - 1].to = best;
      anchors.push({ from: best, to: this.words.length, shift: at - this.words[best].s });
      next = best + 1;
    }
    const changed = anchors.length !== this.anchors.length || anchors.some((a, k) => a.from !== this.anchors[k].from || a.to !== this.anchors[k].to || Math.abs(a.shift - this.anchors[k].shift) > 0.005 || a.start !== this.anchors[k].start);
    this.anchors = anchors;
    return changed;
  }

  /** How far the anchors move word `i` (s): the shift of the last anchor before it (0 before the first). */
  private shiftOf(i: number): number {
    for (const a of this.anchors) if (a.from <= i && i < a.to) return a.shift;
    return 0;
  }

  /** The words of the next reply start arriving (a new "ftv.words" stream): they may come before it is heard. */
  wordsStarted(): void {
    // A new reply's words; it may not be heard yet. Nothing of the last reply's line carries over (its onset, time 0)…
    if (!this.replying) this.resetLine();
    // … and a stream while one is heard is the next reply when no "speaking" edge came between them (state updates
    // can arrive merged); a stream opening just after this reply's own onset is that reply's
    else if (!Number.isNaN(this.onsetAt) && this.ctx.currentTime - this.onsetAt > 1) this.newLine();
    this.wordsCame = true;
    this.sent = [];
    this.words = [];
    this.wordsOnset = NaN;
    this.anchors = [];
    this.cues = [];
  }

  /** The line's timing, forgotten: found again from the next reply's onset. */
  private resetLine() {
    this.onsetAt = NaN;
    this.lineAt = NaN;
    this.follow = 0;
    this.sinceFollow = 0;
  }

  /** A new reply starts: its own line, at a level a little under the last one's. */
  private newLine() {
    this.endedAt = NaN;
    this.resetLine();
    // a new line, but the voice is the same: start from a little under the last reply's peak, not from nothing
    this.peak = Math.max(0.05, this.peak * 0.6);
    this.treblePeak = Math.max(0.01, this.treblePeak * 0.6);
  }

  /** The agent started a reply ("lk.agent.state" speaking). */
  replyStarted(): void {
    this.replying = true;
    this.newLine();
    // the last reply's words, unless this one's have started coming (they can come first): never mouth the old reply
    if (!this.wordsCame) {
      this.sent = [];
      this.words = [];
      this.wordsOnset = NaN;
      this.anchors = [];
      this.cues = [];
    }
    this.wordsCame = false;
  }

  /** The reply is over (finished, or interrupted). */
  replyEnded(): void {
    if (!this.replying) return;
    this.replying = false;
    this.endedAt = this.ctx.currentTime;
  }

  /** Word timings for the current reply, as the agent sends them (ahead of the audio). */
  addWords(words: LiveWord[]): void {
    this.words.push(...words);
    this.place();
    // the words' phonemes (the agent sends only words): the cues are built again once they arrive, usually before the
    // words are heard (they come ahead of the audio)
    queuePhonemes(spokenWords(words.map((w) => w.w).join(" ")), () => {
      if (!this.detached) this.place();
    });
  }

  /** The reply's loudness as the agent sent it: blocks from `k` (RMS × 10 000). */
  addEnvelope(k: number, values: number[]): void {
    for (const [i, v] of values.entries()) this.sent[k + i] = v / 10_000;
    if (this.findAnchors()) this.place(true);
  }

  /** Where the voice starts on the words' clock (seconds), as the agent measured it on the audio it sent. */
  voiceOnset(s: number): void {
    this.wordsOnset = s;
    this.place();
  }

  /** Time 0 where the words' onset meets the voice's here; the cues from the words, each word's letters spread evenly
   *  from its start to its end (the agent times a word from its first letter to its last: punctuation and spaces
   *  around it take no time). */
  private place(anchored = false) {
    if (Number.isNaN(this.onsetAt) || !this.words.length) return;
    this.lineAt = this.pin() + this.follow;
    if (!anchored) this.findAnchors();
    const a: Alignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
    for (const [k, word] of this.words.entries()) {
      const shift = this.shiftOf(k);
      const start = this.anchors.find((a) => a.from === k)?.start;
      const [w, s, e] = [word.w, start ?? word.s + shift, start === undefined ? word.e + shift : Math.max(word.e + shift, start + ACROSS_MIN)];
      const chars = [...w];
      const first = chars.findIndex((c) => LETTER.test(c));
      const last = chars.findLastIndex((c) => LETTER.test(c));
      const step = first < 0 ? 0 : (e - s) / (last - first + 1);
      chars.forEach((c, i) => {
        const at = s + Math.max(0, Math.min(i - first, last - first + 1)) * step;
        a.characters.push(c);
        a.character_start_times_seconds.push(at);
        a.character_end_times_seconds.push(first <= i && i <= last ? at + step : at);
      });
    }
    this.cues = alignmentToCues(a);
  }

  /** How long after the meter sees a sample it is heard, beyond the output path: the held-back voice (LIVE.delay) and
   *  the listener's own Sync setting. The output path itself is in the heard clock (clock.ts). */
  private heardAfter(): number {
    return this.delay + speechPlayer.syncDelayMs / 1000;
  }

  get playing(): boolean {
    if (Number.isNaN(this.lineAt)) return false;
    return this.replying || this.ctx.currentTime - this.endedAt < TAIL_SECONDS + this.delay;
  }

  /** The whole reply has been measured: it ended, and its last sound has had time to reach the meter. */
  get streamDone(): boolean {
    return !this.replying && !(this.ctx.currentTime - this.endedAt < ARRIVAL_SECONDS);
  }

  time(): number {
    return Number.isNaN(this.lineAt) ? -1 : this.clock.heard() - this.heardAfter() - this.lineAt;
  }

  decodedSeconds(): number {
    return Number.isNaN(this.lineAt) ? 0 : this.t0 + this.env.length / 100 - this.lineAt;
  }

  /** The level at line time t. Just past what the meter has measured (the evaluator reads a little ahead: the gate 30 ms,
   *  its window 60 ms, while live the meter is LIVE.delay plus the output latency ahead, less LIPSYNC.lead), the last
   *  measured level holds: read as silence, the mouth opened a few frames after every phrase's sound. */
  private at(arr: number[], peak: number, t: number): number {
    if (Number.isNaN(this.lineAt)) return 0;
    const k = Math.round((this.lineAt + t - this.t0) * 100);
    const v = k >= arr.length && k < arr.length + HOLD_BLOCKS ? arr.at(-1) : arr[k];
    return v === undefined ? 0 : Math.min(1, v / peak);
  }

  loudness(t: number): number {
    return this.at(this.env, this.peak, t);
  }

  trebleLoudness(t: number): number {
    return this.at(this.tre, this.treblePeak, t);
  }
}

/** Pearson correlation of two equal-length series (0 when either is flat). */
function correlation(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}
