/**
 * DEVELOPMENT MOCK (FTV_MOCK_AGENT=1): a character with no AI behind it, so the browser side of a conversation can be
 * built and measured without paid calls. It behaves like the real agent from the room's point of view:
 *
 *   - publishes a microphone-source audio track and plays recorded ElevenLabs v4 Turbo clips into it (24 kHz PCM);
 *   - sends each clip's words on the "lk.transcription" text stream, paced to the audio;
 *   - keeps the "lk.agent.state" attribute (listening / thinking / speaking) and "ftv.mood" up to date;
 *   - takes a turn when the visitor has spoken and gone quiet (loudness on their track, no VAD model), and stops when
 *     they talk over it (an interruption);
 *   - ends at the time limit or after the visitor has been silent too long, with "ftv.end" saying why.
 *
 * The clips carry ElevenLabs' character timings, so the words it sends are the ground truth for live lip sync.
 */
import { type JobContext } from "@livekit/agents";
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, type RemoteParticipant, type RemoteTrack, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "./character.ts";
import type { TalkMetadata } from "./metadata.ts";
import { moodIntensity } from "./mood.ts";
import { OnsetMeter } from "./onset.ts";

const RATE = 24_000;
const FRAME = RATE / 100; // 10 ms
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLIP_DIRS = [join(ROOT, "pipeline/out/lipsync/clips"), join(ROOT, "pipeline/tests/fixtures")];

/** Turn-taking by loudness (16-bit RMS): talking above this; a turn is ≥ MIN_TURN of talk then QUIET of silence. */
const TALKING_RMS = 900;
const MIN_TURN_MS = 400;
const QUIET_MS = 700;
const INTERRUPT_MS = 500;
const THINK_MS = 600;
const IDLE_MS = 20_000;
const MOODS: [string, number][] = [["happy", 0.75], ["surprised", 0.5], ["neutral", 0], ["confused", 0.5], ["happy", 1]];

interface Clip {
  name: string;
  pcm: Int16Array;
  words: { text: string; start: number; end: number }[];
}

/** An NDJSON stream as the speak route returns it: base64 PCM chunks with absolute character timings. */
function loadClip(path: string): Clip {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const parts = lines.map((l) => Buffer.from(l.audio_base64 ?? "", "base64"));
  const bytes = Buffer.concat(parts);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const chars: { c: string; s: number; e: number }[] = [];
  for (const l of lines) {
    const a = l.normalized_alignment ?? l.alignment;
    if (!a) continue;
    a.characters.forEach((c: string, i: number) => chars.push({ c, s: a.character_start_times_seconds[i], e: a.character_end_times_seconds[i] }));
  }
  // Words with the time of their first and last letter, without the audio tag's characters.
  const words: Clip["words"] = [];
  let word: { text: string; start: number; end: number } | null = null;
  let inTag = false;
  for (const { c, s, e } of chars) {
    if (c === "[") inTag = true;
    if (inTag) {
      if (c === "]") inTag = false;
      continue;
    }
    if (/\s/.test(c)) {
      if (word) words.push(word);
      word = null;
    } else if (word) {
      word.text += c;
      word.end = e;
    } else word = { text: c, start: s, end: e };
  }
  if (word) words.push(word);
  return { name: path.split("/").pop()!, pcm, words };
}

function loadClips(): Clip[] {
  for (const dir of CLIP_DIRS) {
    if (!existsSync(dir)) continue;
    // real speech only: development clips recorded in mock mode are tones (no voice onset, nothing to lip-sync)
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson") && !f.startsWith("hello-there")).sort();
    const clips = files.map((f) => loadClip(join(dir, f))).filter((c) => c.pcm.length > RATE && c.words.length);
    if (clips.length) return clips;
  }
  throw new Error("no clips for the canned agent: run the app once in development, or keep pipeline/tests/fixtures");
}

const rms = (frame: AudioFrame) => {
  let sum = 0;
  for (const v of frame.data) sum += v * v;
  return Math.sqrt(sum / Math.max(1, frame.data.length));
};

export async function runCanned(ctx: JobContext, meta: TalkMetadata): Promise<void> {
  const clips = loadClips();
  await ctx.connect();
  const room = ctx.room;
  const me = room.localParticipant!;
  const setState = (state: string) => void me.setAttributes({ "lk.agent.state": state });
  const setMood = (emotion: string, intensity: number) => void me.setAttributes({ "ftv.mood": `${emotion}:${intensity}` });
  setState("initializing");

  const source = new AudioSource(RATE, 1, 200);
  const track = LocalAudioTrack.createAudioTrack("character", source);
  const publication = await me.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  log("canned agent ready", { clips: clips.length, maxSeconds: meta.maxSeconds });

  let speaking = false;
  let stopSpeaking: (() => void) | null = null;
  let lastHeard = Date.now();
  let turn = 0;
  let ended = false;

  const end = async (reason: string) => {
    if (ended) return;
    ended = true;
    log("end", { reason });
    stopSpeaking?.();
    await me.setAttributes({ "ftv.end": reason, "lk.agent.state": "idle" });
    await new Promise((r) => setTimeout(r, 500)); // let the attribute reach the browser
    await ctx.deleteRoom().catch(() => {});
    ctx.shutdown(reason);
  };

  /** Play one clip: audio in 10 ms frames, each word sent when its audio is about to be heard. */
  const speak = async (clip: Clip, mood: [string, number]) => {
    speaking = true;
    setMood(...mood);
    setState("speaking");
    let stopped = false;
    stopSpeaking = () => {
      stopped = true;
      source.clearQueue();
    };
    // the clip's word timings first, ahead of its audio, as the real agent forwards ElevenLabs' (character.ts)
    const words = await me.streamText({ topic: "ftv.words" });
    for (const w of clip.words) await words.write(JSON.stringify({ w: `${w.text} `, s: w.start, e: w.end }) + "\n");
    const onset = new OnsetMeter().push(clip.pcm, RATE);
    if (onset !== null) await words.write(JSON.stringify({ onset }) + "\n");
    await words.close();
    const writer = await me.streamText({
      topic: "lk.transcription",
      attributes: { "lk.segment_id": `SG_${turn++}`, "lk.transcribed_track_id": publication.sid ?? "", "lk.transcription_final": "false" },
    });
    let next = 0;
    for (let i = 0; i < clip.pcm.length && !stopped && !ended; i += FRAME) {
      const data = clip.pcm.slice(i, i + FRAME);
      await source.captureFrame(new AudioFrame(data, RATE, 1, data.length));
      const heard = i / RATE - 0.2; // the source's queue is 200 ms ahead of what is heard
      while (next < clip.words.length && clip.words[next].start <= heard) await writer.write((next ? " " : "") + clip.words[next++].text);
    }
    if (!stopped) await source.waitForPlayout();
    while (!stopped && next < clip.words.length) await writer.write((next ? " " : "") + clip.words[next++].text);
    await writer.close();
    speaking = false;
    stopSpeaking = null;
    lastHeard = Date.now();
    if (!ended) setState("listening");
  };

  const reply = async () => {
    setState("thinking");
    await new Promise((r) => setTimeout(r, THINK_MS));
    if (!ended) await speak(clips[turn % clips.length], MOODS[turn % MOODS.length]);
  };

  // The visitor's microphone: talking, quiet, interruptions.
  const listen = async (audio: RemoteTrack) => {
    let talkingFor = 0;
    let quietFor = 0;
    let saidSomething = false;
    log("listening to the visitor's microphone");
    for await (const frame of new AudioStream(audio, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 })) {
      if (ended) break;
      const ms = (frame.samplesPerChannel / frame.sampleRate) * 1000;
      if (rms(frame) > TALKING_RMS) {
        talkingFor += ms;
        quietFor = 0;
        lastHeard = Date.now();
        if (speaking && talkingFor >= INTERRUPT_MS) {
          stopSpeaking?.(); // talked over: stop at once, and listen
          log("interrupted");
        }
        if (talkingFor >= MIN_TURN_MS) saidSomething = true;
      } else {
        quietFor += ms;
        if (quietFor > 150) talkingFor = 0;
        if (saidSomething && !speaking && quietFor >= QUIET_MS) {
          saidSomething = false;
          void reply();
        }
      }
    }
  };
  room.on(RoomEvent.TrackSubscribed, (t: RemoteTrack, _pub: unknown, p: RemoteParticipant) => {
    if (t.kind === TrackKind.KIND_AUDIO && p.identity !== me.identity) void listen(t);
  });
  for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.track?.kind === TrackKind.KIND_AUDIO) void listen(pub.track as RemoteTrack);
  room.on(RoomEvent.ParticipantDisconnected, () => void end("left"));

  const limit = setTimeout(() => void end("time_up"), meta.maxSeconds * 1000);
  const idle = setInterval(() => {
    if (!speaking && Date.now() - lastHeard > IDLE_MS) void end("idle");
  }, 1000);
  ctx.addShutdownCallback(async () => {
    clearTimeout(limit);
    clearInterval(idle);
  });

  await ctx.waitForParticipant();
  setMood(meta.startMood.emotion, moodIntensity(meta.startMood.strength));
  await speak(clips[turn % clips.length], [meta.startMood.emotion, moodIntensity(meta.startMood.strength)]); // the greeting
}
