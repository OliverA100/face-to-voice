/**
 * True word times from ElevenLabs' sockets, on the reply's own clock, each word from its first letter to its last.
 *
 * Flash v2.5 (the text-to-speech socket): the character times are already on the context's clock, but the plugin moves
 * every word earlier by the first character's time (its `firstWordOffsetMs`: the greeting's words ran 40–250 ms ahead
 * of the voice) and times words with the space and punctuation after them. Read here, they need neither.
 *
 * v3/v4 (the dialogue socket) sends messages with audio, characters, or both, in turns (a sentence each,
 * ending with is_final_audio_for_turn). A message's character times restart at 0, and its characters often run past
 * its own audio ("Wait for": 0.88 s of characters on 0.67 s of audio). Tested against the agent's own audio on five
 * real replies: within a turn, a message's characters follow on from where the last message's last character ended,
 * but never start later than the message's own audio (each turn starts where its first characters' audio does).
 * Words then sit within ~±60 ms of the sound (one half-reply 180 ms); timing each message from its own audio drifted
 * up to 470 ms late by a reply's end, and a clock of character times alone (Pipecat's) up to 310 ms late. Stretching
 * each turn to its audio fits a little better, but needs the turn's end, after its first words are heard.
 *
 * The LiveKit plugin (1.9.2) loses that: it re-cuts the characters into words across messages without the offset, so
 * live, words started before the ones before them and drifted ~0.4 s late by a reply's end. Two small patches:
 *   - the plugin's websocket: every message is read here first (the plugin's own handling is untouched), and
 *     each context's characters are kept with their absolute times;
 *   - the plugin's stream: when it pushes words (pushTimedTranscript), each word takes its times from those characters
 *     (the words are consecutive slices of the same character stream), from its first letter to its last, before
 *     anything reads them: the captions' pacing and the lip sync's "ftv.words" both get true times.
 * Both reach into the plugin's internals, so they go in only for the plugin version they were written against, with
 * every method they wrap present (pluginMismatch); otherwise the plugin's own timings are used, and the log says why.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SynthesizeStream } from "@livekit/agents-plugin-elevenlabs";
import type { voice } from "@livekit/agents";

export interface Timeline {
  audio: number; // seconds of audio received so far
  clock: number; // where the next message's characters follow on from (the last one's last character end)
  newTurn: boolean; // the next characters open a turn (the context's first, or after is_final_audio_for_turn)
  text: string; // the characters so far (as the plugin slices its text: UTF-16 code units)
  matched: number; // where the last word found in them ended
  starts: number[]; // per character (UTF-16 code unit, as the plugin slices its text), absolute seconds
  ends: number[];
  cursor: number; // characters already given to words
}

/** One message from the dialogue socket (the fields used here). */
export interface DialogueMessage {
  context_id?: string;
  audio?: string; // base64 16-bit mono PCM
  alignment?: { chars?: string[]; char_start_times_ms?: number[]; char_durations_ms?: number[] };
  is_final_audio_for_turn?: boolean;
}

/**
 * One message into a context's timeline: its characters' absolute times, then its audio. `absolute`: the character
 * times are already on the context's clock (the text-to-speech socket, Flash v2.5), not restarted per message.
 */
export function recordMessage(t: Timeline, m: DialogueMessage, sampleRate: number, absolute = false): void {
  const a = m.alignment;
  // the plugin skips a message whose three lists differ in length; so does this (one bad time would spoil the rest)
  if (a?.chars?.length && a.char_start_times_ms?.length === a.chars.length && a.char_durations_ms?.length === a.chars.length) {
    if (t.newTurn) t.clock = t.audio;
    t.newTurn = false;
    const base = absolute ? 0 : Math.min(t.clock, t.audio);
    a.chars.forEach((c, i) => {
      // never before the character before it (a message's first one can be stamped back into the last message's)
      const start = Math.max(base + a.char_start_times_ms![i] / 1000, t.starts.at(-1) ?? 0);
      const end = start + (a.char_durations_ms![i] ?? 0) / 1000;
      t.text += c;
      for (let k = 0; k < c.length; k++) {
        t.starts.push(start);
        t.ends.push(end);
      }
    });
    const n = a.chars.length - 1;
    t.clock = base + (a.char_start_times_ms[n] + (a.char_durations_ms[n] ?? 0)) / 1000;
  }
  if (m.is_final_audio_for_turn) t.newTurn = true;
  if (m.audio) t.audio += Buffer.byteLength(m.audio, "base64") / 2 / sampleRate; // 16-bit mono samples
}

/** A text-to-speech socket message (Flash v2.5): camelCase, and the normalized alignment the plugin reads by default. */
interface SpeechMessage {
  contextId?: string;
  context_id?: string;
  audio?: string;
  alignment?: SpeechAlignment;
  normalizedAlignment?: SpeechAlignment;
}
type SpeechAlignment = { chars?: string[]; charStartTimesMs?: number[]; charsStartTimesMs?: number[]; charDurationsMs?: number[]; charsDurationsMs?: number[] };

function fromSpeechSocket(m: SpeechMessage): DialogueMessage {
  const a = m.normalizedAlignment ?? m.alignment;
  return {
    context_id: m.contextId ?? m.context_id,
    audio: m.audio ?? undefined,
    alignment: a && { chars: a.chars, char_start_times_ms: a.charStartTimesMs ?? a.charsStartTimesMs, char_durations_ms: a.charDurationsMs ?? a.charsDurationsMs },
  };
}

export const newTimeline = (): Timeline => ({ audio: 0, clock: 0, newTurn: true, text: "", matched: 0, starts: [], ends: [], cursor: 0 });

/** Letters compared loosely: case, and curly or straight quotes. */
const fold = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
/** How far before (characters) and after the counted position a word is looked for. */
const LOOK_BACK = 4;
const LOOK_AHEAD = 40;

/**
 * The next word's [start, end] (s): from its first letter to its last (a full stop or comma after it is stamped with
 * the pause that follows: "before. " ran 0.45 s into the silence after it). Found by its letters in the characters,
 * near where counting puts it: the plugin's words are slices of the same characters, but its text and these can be
 * out of step (the context's leading space, a message it skipped), and counting alone then gave every later word a
 * later word's time (a reply's last words 1.2 s late).
 * Null when its characters haven't come yet.
 */
export function timeWord(t: Timeline, text: string): [number, number] | null {
  const counted = t.cursor;
  t.cursor += text.length;
  const letters = /[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/su.exec(text);
  if (!letters) return null;
  const want = fold(letters[0]);
  const hay = fold(t.text);
  let at = -1;
  const last = Math.min(hay.length - want.length, counted + letters.index + LOOK_AHEAD);
  for (let k = Math.max(t.matched, counted + letters.index - LOOK_BACK); k <= last; k++) {
    if (hay.startsWith(want, k)) {
      at = k;
      break;
    }
  }
  if (at < 0) at = counted + letters.index; // not found: where counting puts it
  else t.cursor = at + want.length + (text.length - letters.index - want.length); // back in step
  const end = at + want.length - 1;
  if (end >= t.starts.length) return null;
  t.matched = end + 1;
  return [t.starts[at], t.ends[end]];
}

/** The plugin version the patches were written and checked against (package.json pins it). */
export const PATCHED_PLUGIN = "1.9.2";

const pluginEntry = () => import.meta.resolve("@livekit/agents-plugin-elevenlabs");
type WsPrototype = { on: (...a: unknown[]) => unknown };
const pluginWebSocket = () => (createRequire(pluginEntry())("ws") as { WebSocket?: { prototype?: WsPrototype } }).WebSocket;

/** Why the patches can't go in (null when they can): another plugin version, or something they wrap is missing. */
export function pluginMismatch(): string | null {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(pluginEntry())), "..", "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== PATCHED_PLUGIN) return `plugin ${pkg.version}, patched for ${PATCHED_PLUGIN}`;
  const proto = SynthesizeStream.prototype as unknown as Record<string, unknown>;
  for (const name of ["pushTimedTranscript", "markDone", "close"]) if (typeof proto[name] !== "function") return `no SynthesizeStream.${name}`;
  if (!Object.getOwnPropertyDescriptor(proto, "contextId")?.get) return "no SynthesizeStream.contextId";
  if (typeof pluginWebSocket()?.prototype?.on !== "function") return "no ws WebSocket.on";
  return null;
}

let installed = false;

/** `sampleRate`: the TTS output's (the plugin's encoding, pcm_22050 by default). False: left out (pluginMismatch). */
export function fixWordTimings(sampleRate: number): boolean {
  if (installed) return true;
  const mismatch = pluginMismatch();
  if (mismatch) {
    console.warn(`[ftv] word timings left to the plugin: ${mismatch}`);
    return false;
  }
  installed = true;
  const timelines = new Map<string, Timeline>();
  const finished = new Set<string>(); // contexts done with (a late message must not start a timeline again)
  const timeline = (id: string) => timelines.get(id) ?? timelines.set(id, newTimeline()).get(id)!;
  const forget = (id: string) => {
    timelines.delete(id);
    finished.add(id);
  };

  // 1. The socket: the same `ws` module instance the plugin uses (every socket in the process, matched by its URL).
  const wsProto = pluginWebSocket()!.prototype!;
  const on = wsProto.on;
  wsProto.on = function (this: { url?: string }, event: unknown, listener: unknown) {
    const dialogue = !!this.url?.includes("/text-to-dialogue/");
    if (event === "message" && typeof listener === "function" && (dialogue || this.url?.includes("/multi-stream-input"))) {
      const read = listener as (data: unknown, ...rest: unknown[]) => unknown;
      const wrapped = (data: unknown, ...rest: unknown[]) => {
        record(data, dialogue);
        return read(data, ...rest);
      };
      wrapped.listener = read; // so the plugin's ws.off("message", its listener) still finds it (as EventEmitter.once does)
      return on.call(this, event, wrapped);
    }
    return on.call(this, event, listener);
  };

  function record(data: unknown, dialogue: boolean) {
    let m: DialogueMessage;
    try {
      m = JSON.parse(String(data));
      if (!dialogue) m = fromSpeechSocket(m as unknown as SpeechMessage);
    } catch {
      return;
    }
    if (m.context_id && !finished.has(m.context_id)) recordMessage(timeline(m.context_id), m, sampleRate, !dialogue);
  }

  // 2. The stream: words re-timed from the characters they are made of.
  const proto = SynthesizeStream.prototype as unknown as {
    pushTimedTranscript(words: voice.TimedString[]): void;
    markDone(): void;
    close(): void;
  };
  const { pushTimedTranscript, markDone, close } = proto;
  proto.pushTimedTranscript = function (this: { contextId: string }, words: voice.TimedString[]) {
    const t = timelines.get(this.contextId);
    if (t) {
      for (const w of words) {
        const times = timeWord(t, w.text);
        if (times) [w.startTime, w.endTime] = times;
      }
    }
    return pushTimedTranscript.call(this, words);
  };
  proto.markDone = function (this: { contextId: string }) {
    forget(this.contextId);
    return markDone.call(this);
  };
  // interrupted, failed or timed out: the plugin closes the stream without markDone
  proto.close = function (this: { contextId: string }) {
    forget(this.contextId);
    return close.call(this);
  };
  return true;
}
