/**
 * The character: a LiveKit voice Agent whose LLM step calls Claude directly.
 *
 * Why its own llmNode instead of the Anthropic plugin's: the plugin (1.9.2) bundles an old Anthropic SDK and sends
 * neither `thinking` nor `cache_control`. Claude Haiku 5.5 thinks by default, which delays the first word, and the
 * character's instructions are the same on every turn, so caching them is free speed. Here the stream also passes
 * through MoodTag: the leading "[happy 2]" becomes a v4 audio tag for the voice and a participant attribute for the
 * face, and is never spoken.
 *
 *   ChatContext ──► messages.stream (Haiku 5.5, thinking off, auto-cached) ──► MoodTag ──► "[cheerful] Oh, hello!" ──► TTS
 *                                                                               └──► onMood(mood) ──► attribute ftv.mood
 */
import Anthropic from "@anthropic-ai/sdk";
import { llm, USERDATA_TIMED_TRANSCRIPT, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

import type { TalkMetadata } from "./metadata.ts";
import { audioTag, type Mood, MoodTag } from "./mood.ts";
import { Envelope, OnsetMeter } from "./onset.ts";

export const LLM_MODEL = process.env.CLAUDE_MODEL_TALK || "claude-haiku-5-5";
export const TTS_MODEL = process.env.TTS_MODEL_TALK || "eleven_v4_turbo";
/** ElevenLabs' dialogue socket (eleven_v3*, eleven_v4*): its word times need rebasing (elevenTimings.ts). */
export const DIALOGUE_MODEL = /^eleven_v[34]/.test(TTS_MODEL);
/** A spoken reply is one or two short sentences (the instructions and each turn's note say so); a reply still going
 *  past this many words ends with the sentence it is in (SentenceCap), and MAX_TOKENS stops a runaway outright. */
export const REPLY_WORDS = 22;
const MAX_TOKENS = 120;

type Turn = Anthropic.MessageParam;

/**
 * The visitor's words without the plain copy LiveKit Inference's AssemblyAI stream sends after each formatted turn
 * ("Yeah, I am. yeah i am": both are final transcripts, and the session joins them; format_turns: false doesn't stop
 * it). A plain run of words (lower case, no punctuation) that repeats the formatted turn just before it is dropped:
 * the turn starts the text, a sentence or a capital, and ends a sentence itself, and the copy ends the text or is
 * followed by the next turn's capital. Words said twice inside a sentence ("very, very good") stay.
 */
export function withoutPlainCopies(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const ends = (w: string | undefined) => !w || /[.?!]["')]*$/.test(w); // a sentence's end (or the text's start)
  for (let i = 1; i < words.length; i++) {
    for (let n = Math.min(i, words.length - i); n >= 1; n--) {
      const copy = words.slice(i, i + n);
      if (!copy.every((w) => w === bare(w))) continue; // the copy is plain: lower case, no punctuation
      const before = words.slice(i - n, i);
      const turn = (ends(words[i - n - 1]) || /^\p{Lu}/u.test(before[0])) && ends(before.at(-1));
      const next = words[i + n];
      const copyEnds = next === undefined || /^\p{Lu}/u.test(next);
      // … of a formatted turn just before it (capitals or punctuation): a plain run after a plain run was said twice
      if (turn && copyEnds && before.some((w) => w !== bare(w)) && copy.every((w, k) => w === bare(before[k]))) {
        words.splice(i, n);
        i--;
        break;
      }
    }
  }
  return words.join(" ");
}

/**
 * The conversation as Claude takes it: system text apart, user/assistant turns alternating and starting with the user.
 *
 * Built so the prompt cache keeps hitting (a cache read is a prefix match): what was sent once is sent again byte for
 * byte, and only the end is new.
 *   - `base` is the character's own instructions: a one-off instruction for a single reply (generateReply's, e.g.
 *     "check in with them") arrives merged into the system text; it moves to a note at the very end instead, so the
 *     system prompt never changes.
 *   - The app's standing notes stay on the visitor turn they were added to, in every later request too (moved to the
 *     last turn each time, they would rewrite the history and the cache would never be read back).
 *   - Two replies in a row (a check-in after a silence) keep the visitor's silence between them, rather than being
 *     joined into one turn that the next request would write differently.
 *
 * `moodOf` gives back the mood tag of an earlier reply (kept on its history item: CharacterAgent.keepMood): the history
 * keeps each reply as it was captioned, without its "[happy 2]", and a model that sees its own turns untagged soon
 * stops tagging (the face stops changing after the first reply). The tags are put back, and a note on each visitor turn
 * reminds it.
 *
 * The visitor's words can't pass for the app's notes: "note from the app" in them (in any spacing or punctuation)
 * loses its "from the app".
 *
 * The character's want has no note of its own: the instructions bring it in within the first few replies, so the first
 * reply is free to answer whatever the visitor said.
 */
export function toClaude(chatCtx: llm.ChatContext, base?: string, moodOf?: (reply: llm.ChatMessage) => Mood | null): { system: string; messages: Turn[] } {
  const system: string[] = [];
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const item of chatCtx.items) {
    if (item.type !== "message") continue;
    const text = item.textContent?.trim();
    if (!text) continue;
    if (item.role === "system" || item.role === "developer") {
      system.push(text);
      continue;
    }
    const mood = item.role === "assistant" ? moodOf?.(item) : null;
    const said = mood ? `[${mood.emotion}${mood.strength ? ` ${mood.strength}` : ""}] ${text}` : item.role === "user" ? visitorSaid(text) : text;
    const last = turns.at(-1);
    if (last?.role === "user" && item.role === "user") last.text = `${last.text}\n${said}`;
    else {
      // Claude needs the conversation to open with the visitor, and turns to alternate
      if (item.role === "assistant" && last?.role !== "user") turns.push({ role: "user", text: last ? SILENT : WALKS_UP });
      turns.push({ role: item.role, text: said });
    }
  }
  if (turns.at(-1)?.role !== "user") turns.push({ role: "user", text: turns.length ? SILENT : WALKS_UP });

  const messages: Turn[] = turns.map(({ role, text }) => {
    if (role === "assistant") return { role, content: text };
    const notes = ["reply in one or two short sentences, under 20 words", ...(moodOf ? ["begin it with your mood tag"] : [])];
    return { role, content: `${text}\n\n(Note from the app: ${notes.join("; ")}.)` };
  });

  let text = system.join("\n\n");
  const own = base?.trim(); // the system text arrives trimmed
  if (own && text !== own && text.startsWith(own)) {
    const extra = text.slice(own.length).trim();
    text = own;
    const last = messages.at(-1)!;
    last.content = `${last.content as string}\n\n(Note from the app, not said by the visitor: ${extra})`;
  }
  return { system: text, messages };
}

/** The visitor's turn as Claude reads it: once (withoutPlainCopies), and never passing for the app's own notes. */
const visitorSaid = (text: string) => withoutPlainCopies(text).replace(/note\W+from\W+the\W+app/gi, "note");

const WALKS_UP = "(The visitor walks up.)";
const SILENT = "(The visitor says nothing.)";

/** The opening of a later chat in the same visit: a welcome back in new words, not the greeting they heard last time.
 *  Several examples, so the welcomes don't all come out as the same one. */
export const againNote = (greeting: string) =>
  `The visitor has come back for another chat. Greet them as someone you've met before, in your own words (like ` +
  `"Oh, it's you again!", "Look who's back.", "Twice in one day?" or "Ah, my favourite visitor."), then say something ` +
  `new about you or your day, in one or two short sentences (under 20 words in all); don't repeat or reword your first ` +
  `greeting ("${greeting}"), and don't claim to remember what was said last time.`;

/** Claude sending nothing for this long (before a reply's first word or between two) is a failed reply. */
export const QUIET_MS = 8000;
/** The longest stage direction ActionStrip drops ("(laughs softly)", "*clears throat nervously*"). */
const ACTION_MAX = 40;
export const AGAIN_LINE = "Sorry, I lost my thread there. Could you say that again?";
export const GIVE_UP_LINE = "Sorry, I can't think straight right now. Let's talk another time.";

/** A request that sent nothing for QUIET_MS (withDeadline). */
export class Stalled extends Error {
  override name = "Stalled";
}

/**
 * `source`, failing with Stalled when the next item takes longer than `ms` to come (`onStall` is called first: it
 * aborts the request). Only the wait for the source counts, not the time the reader takes between items.
 */
export async function* withDeadline<T>(source: AsyncIterable<T>, ms: number, onStall: () => void): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = it.next();
      next.catch(() => {}); // after a stall, the aborted request's rejection has no one waiting for it
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onStall();
          reject(new Stalled());
        }, ms);
      });
      let got: IteratorResult<T>;
      try {
        got = await Promise.race([next, stalled]);
      } finally {
        clearTimeout(timer);
      }
      if (got.done) return;
      yield got.value;
    }
  } finally {
    await it.return?.()?.catch?.(() => {});
  }
}

/**
 * Replies Claude couldn't give, in a row: the first gets an apology and another try, the second a goodbye, and the
 * chat ends after it. A reply that comes through starts the count again.
 */
export class Trouble {
  private inRow = 0;

  ok(): void {
    this.inRow = 0;
  }

  /** A reply failed: the line said instead, and whether the chat ends after it. */
  failed(): { line: string; end: boolean } {
    this.inRow++;
    return this.inRow >= 2 ? { line: GIVE_UP_LINE, end: true } : { line: AGAIN_LINE, end: false };
  }
}

/** Where a reply's word timings go: a text stream to the browser ("ftv.words"), one per reply. */
export type OpenWords = () => Promise<{ write(text: string): Promise<void>; close(): Promise<void> }>;

export class CharacterAgent extends voice.Agent {
  private readonly meta: TalkMetadata;
  private readonly onMood: (mood: Mood) => void;
  private readonly openWords: OpenWords | null;
  /** The mood of the reply written last: shown when that reply starts playing (transcriptionNode), not when it is
   *  written, because preemptive generation can write a reply that is then thrown away. */
  private pendingMood: Mood | null = null;
  /**
   * A line to say as the next reply, word for word, without asking Claude (the greeting). It goes through the reply
   * pipeline rather than session.say(), because only that path gives transcriptionNode the TTS's word timings, which
   * the lip sync needs.
   */
  private scripted: { text: string; mood: Mood } | null = null;

  /** The mood of the reply being spoken now: kept on its history item once it is added (keepMood). */
  private spokenMood: Mood | null = null;

  /** A reply joined the history (finished or cut short): it keeps the mood it was spoken in, for toClaude. */
  keepMood(item: llm.ChatItem): void {
    if (item.type === "message" && item.role === "assistant" && this.spokenMood) item.extra[MOOD_KEY] = this.spokenMood;
  }

  /** The next reply is this line (call session.generateReply() to say it). */
  script(text: string, mood: Mood): void {
    this.scripted = { text, mood };
  }
  private readonly claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 15_000 });
  private readonly trouble = new Trouble();
  /** Called once a reply has failed twice in a row: the goodbye is on its way, and the chat should end after it. */
  private readonly onGiveUp: () => void;

  constructor(meta: TalkMetadata, onMood: (mood: Mood) => void, openWords: OpenWords | null = null, onGiveUp: () => void = () => {}) {
    super({ instructions: meta.instructions });
    this.meta = meta;
    this.onMood = onMood;
    this.openWords = openWords;
    this.onGiveUp = onGiveUp;
  }

  override async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string>> {
    if (this.scripted) {
      const { text, mood } = this.scripted;
      this.scripted = null;
      this.pendingMood = mood;
      return ReadableStream.from([(DIALOGUE_MODEL ? audioTag(mood, this.meta.moodTags) : "") + text]);
    }
    const moodOf = (item: llm.ChatMessage) => (item.extra[MOOD_KEY] as Mood | undefined) ?? null;
    const { system, messages } = toClaude(chatCtx, this.meta.instructions, moodOf);
    const tag = new MoodTag(new Set(["neutral", ...Object.keys(this.meta.moodTags)]));
    const { meta, claude, trouble, onGiveUp } = this;
    const setPending = (mood: Mood | null) => (this.pendingMood = mood);
    // The request starts on the first read (the framework reads at once: preemptive replies are sent too), and stops
    // the moment the reply is thrown away or cut short (cancel), not at the next word Claude sends.
    let current: { abort(): void } | null = null;
    async function* reply(): AsyncGenerator<string> {
      const started = performance.now();
      const stream = claude.messages.stream({
        model: LLM_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "disabled" },
        // Cached twice: the character's instructions on their own (the same all conversation: read even when the
        // history changes) and, automatically, everything up to the visitor's last turn.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        cache_control: { type: "ephemeral" },
      });
      current = stream;
      const cap = new SentenceCap(REPLY_WORDS);
      const actions = new ActionStrip(); // "*chuckles*" is never spoken
      let first = true;
      try {
        for await (const event of withDeadline(stream, QUIET_MS, () => stream.abort())) {
          if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
          const text = tag.push(event.delta.text);
          if (first && (text || tag.mood)) {
            first = false;
            trouble.ok(); // Claude is answering
            setPending(tag.mood ?? { emotion: "neutral", strength: 0 });
            if (tag.mood) {
              // v3/v4 read audio tags; other models would say them out loud
              const voiceTag = DIALOGUE_MODEL ? audioTag(tag.mood, meta.moodTags) : "";
              if (voiceTag) yield voiceTag;
            }
            log("first text", { ms: Math.round(performance.now() - started) });
          }
          const said = text && cap.push(actions.push(text));
          if (said) yield said;
          if (cap.done) break; // long enough: the rest is never said (or paid for)
        }
        if (cap.done) {
          log("reply capped", { words: cap.words });
          return;
        }
        const rest = cap.push(actions.push(tag.flush()) + actions.flush());
        if (rest) yield rest;
        const { usage } = await stream.finalMessage();
        log("usage", { input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens, output: usage.output_tokens });
      } catch (e) {
        const err = e as { status?: number; name?: string };
        if (err?.name === "APIUserAbortError") throw e; // cut short or thrown away (cancel): not a failure
        // A status and a name, no words. The framework would only log a thrown error (at error level, kept out of the
        // logs: Dockerfile) and leave the visitor waiting, so the character says so in its own voice instead.
        log("llm error", { status: err?.status, name: err?.name });
        const { line, end } = trouble.failed();
        if (first) {
          setPending({ emotion: "neutral", strength: 0 });
          yield line;
        }
        if (end) onGiveUp();
      } finally {
        stream.abort(); // stop paying for words nobody will hear (a no-op once finished)
      }
    }
    const words = reply();
    return new ReadableStream<string>({
      async pull(out) {
        const next = await words.next();
        if (next.done) out.close();
        else out.enqueue(next.value);
      },
      async cancel() {
        current?.abort();
        await words.return(undefined).catch(() => {});
      },
    });
  }

  /**
   * The voice as it is made: each audio frame carries the words that came with its chunk of speech
   * (frame.userdata[USERDATA_TIMED_TRANSCRIPT]), on the reply's clock (for v3/v4 after elevenTimings.ts). They go
   * straight to the browser on "ftv.words" for the lip sync: this runs as the voice is made, ahead of playback.
   */
  override async ttsNode(text: ReadableStream<string>, modelSettings: voice.ModelSettings): Promise<ReadableStream<AudioFrame> | null> {
    const frames = await voice.Agent.default.ttsNode(this, text, modelSettings);
    if (!frames) return null;
    const open = this.openWords;
    let writer: ReturnType<OpenWords> | null = null;
    let sent: Promise<unknown> = Promise.resolve(); // in order, and never holding up the voice
    const send = (line: string) => {
      if (!open) return;
      const w = (writer ??= open());
      sent = sent.then(async () => (await w).write(line)).catch(() => {});
    };
    const strip = new BracketStrip();
    // where the voice starts on the words' clock: the browser pins the words there (onset.ts)
    const meter = new OnsetMeter();
    // the reply's loudness for the browser to line up with what it hears, sent 100 ms at a time ({k: first block, env})
    const envelope = new Envelope();
    let pending: number[] = [];
    const sendEnvelope = () => {
      if (!pending.length) return;
      send(JSON.stringify({ k: envelope.count - pending.length, env: pending }) + "\n");
      pending = [];
    };
    // how far the voice fell behind real time (the voice ran dry mid-reply): timings only
    let firstFrameAt = 0;
    let audioSeconds = 0;
    let behind = 0;
    let firstWord: number | null = null;
    const close = () => {
      const w = writer;
      if (w) sent = sent.then(async () => (await w).close()).catch(() => {});
    };
    return frames.pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform(frame, out) {
          const words = frame.userdata?.[USERDATA_TIMED_TRANSCRIPT] as voice.TimedString[] | undefined;
          for (const w of words ?? []) {
            if (w.startTime === undefined || w.endTime === undefined) continue;
            const t = strip.push(w.text);
            if (!/[\p{L}\p{N}]/u.test(t)) continue; // a lone dash or quote: nothing to say, no time of its own
            firstWord ??= w.startTime;
            send(JSON.stringify({ w: t, s: +w.startTime.toFixed(3), e: +w.endTime.toFixed(3) }) + "\n");
          }
          if (meter.onset === null && meter.push(frame.data, frame.sampleRate, frame.channels) !== null) {
            send(JSON.stringify({ onset: +meter.onset!.toFixed(3) }) + "\n");
          }
          for (const rms of envelope.push(frame.data, frame.sampleRate, frame.channels)) pending.push(Math.round(rms * 10_000));
          if (pending.length >= 10) sendEnvelope();
          const now = performance.now() / 1000;
          if (!firstFrameAt) firstFrameAt = now;
          behind = Math.max(behind, now - firstFrameAt - audioSeconds);
          audioSeconds += frame.samplesPerChannel / frame.sampleRate;
          out.enqueue(frame);
        },
        flush() {
          // timings only, never words: how far ElevenLabs' first-word stamp is from the voice
          if (meter.onset !== null && firstWord !== null) log("voice onset", { onsetMs: Math.round(meter.onset * 1000), firstWordMs: Math.round(firstWord * 1000) });
          log("voice pace", { audioMs: Math.round(audioSeconds * 1000), behindMs: Math.round(behind * 1000) });
          sendEnvelope();
          close();
        },
        cancel: close, // an interrupted reply: its words' stream ends too

      }),
    );
  }

  /** Captions without brackets (the audio tag comes back in the TTS's aligned words); the reply's mood to the face. */
  override async transcriptionNode(text: ReadableStream<string | voice.TimedString> | AsyncIterable<string | voice.TimedString>): Promise<ReadableStream<string | voice.TimedString>> {
    const strip = new BracketStrip();
    const source = text instanceof ReadableStream ? text : ReadableStream.from(text);
    // This reply is now being spoken: its mood goes to the face (once), and to its history item when it is added.
    const mood = this.pendingMood;
    this.pendingMood = null;
    this.spokenMood = mood;
    let shown = false;
    const show = () => {
      if (shown || !mood) return;
      shown = true;
      this.onMood(mood);
    };
    return source.pipeThrough(
      new TransformStream<string | voice.TimedString, string | voice.TimedString>({
        transform(chunk, out) {
          show();
          const t = strip.push(typeof chunk === "string" ? chunk : chunk.text);
          if (!t) return;
          out.enqueue(typeof chunk === "string" ? t : voice.createTimedString({ ...chunk, text: t }));
        },
      }),
    );
  }
}

/** Where a reply's mood is kept on its history item (ChatMessage.extra). */
const MOOD_KEY = "ftv.mood";

/**
 * Lets a reply through up to the end of the sentence in which it passes `words` words, then nothing: a long reply
 * ends on a full sentence rather than mid-word. Fed the reply's text piece by piece.
 */
export class SentenceCap {
  words = 0;
  done = false;
  private inWord = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  push(s: string): string {
    if (this.done) return "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const space = /\s/.test(c);
      if (!space && !this.inWord) this.words++;
      this.inWord = !space;
      // a sentence ends at . ! ? or … followed by a space, or at the end of what has come so far
      if (this.words >= this.max && /[.!?…]/.test(c) && (i + 1 === s.length || /\s/.test(s[i + 1]))) {
        this.done = true;
        return s.slice(0, i + 1);
      }
    }
    return s;
  }
}

/** Drops "[…]" from a stream of text, even when a bracket pair spans pieces. */
export class BracketStrip {
  private inside = false;
  push(s: string): string {
    let out = "";
    for (const c of s) {
      if (c === "[") this.inside = true;
      else if (c === "]") this.inside = false;
      else if (!this.inside) out += c;
    }
    return out;
  }
}

/**
 * Drops stage directions from a reply as it streams: "*chuckles softly*" and "(sighs)", even across pieces, with the
 * space they leave collapsed. The instructions forbid them, but a delivery quirk ("chuckles between sentences") still
 * brings them out, and the voice would read them aloud. Text after a "*" or "(" is held until it closes; one that
 * doesn't close within ACTION_MAX characters, or by the end of the reply (flush), wasn't a stage direction ("5 * 3",
 * ":(") and is said after all, without the symbol.
 */
export class ActionStrip {
  private close: string | null = null;
  private held = "";
  private space = false;

  push(s: string): string {
    let out = "";
    for (const c of s) {
      if (this.close) {
        if (c === this.close) {
          this.close = null;
          this.held = "";
        } else if ((this.held += c).length > ACTION_MAX) out += this.flush();
        continue;
      }
      if (c === "*" || c === "(") this.close = c === "*" ? "*" : ")";
      else out += this.say(c);
    }
    return out;
  }

  /** The text held after an opener that hasn't closed: said after all (at the end of the reply, or once it runs long). */
  flush(): string {
    const held = this.held;
    this.close = null;
    this.held = "";
    return this.say(held);
  }

  private say(text: string): string {
    let out = "";
    for (const c of text) {
      const space = /\s/.test(c);
      if (space && this.space) continue;
      this.space = space;
      out += c;
    }
    return out;
  }
}

/** Numbers only: never the visitor's words or the replies. */
export function log(what: string, fields: Record<string, unknown> = {}): void {
  console.log(`[ftv] ${what}`, JSON.stringify(fields));
}
