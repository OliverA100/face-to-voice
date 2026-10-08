/**
 * The emotion chosen in the panel, on the server: validated against sliders.json (never free text),
 * turned into an ElevenLabs audio tag for the speak route, into words for the face description, and
 * into the emotion the voice is designed in (emotionVoice, the first words of the prompt's "Emotion:").
 *
 * The TTS model (eleven_v4_turbo) reads audio tags: "[happy] Hello there." The tag is built here from
 * the allow-listed id, and square brackets typed by the visitor are removed, so only our tags reach the
 * model. The tag's characters come back in the alignment; the lip sync drops them (lipsync/cues.ts
 * stripTags). Neutral adds no tag.
 */
// Pure module (no server-only import) so it can be unit-tested; only server code imports it.
import { z } from "zod";

import slidersJson from "@/data/sliders.json";

export const NEUTRAL = "neutral";
const items = (slidersJson as unknown as { emotions: { items: { id: string; label: string }[] } }).emotions.items;
export const EMOTION_IDS = [NEUTRAL, ...items.map((e) => e.id)] as [string, ...string[]];
const LABELS = new Map(items.map((e) => [e.id, e.label.toLowerCase()]));

/** Intensity in quarter steps (0, 0.25 … 1): what the tags and the cache keys see. */
export const quantiseIntensity = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 4) / 4;

/**
 * The audio tag per emotion (free-form in v4): how the line is said, at a hint (a quarter or half), clear (three
 * quarters) and full. The tag is the only thing that carries an expression chosen after the voice was designed, so
 * it names the delivery too ("shaky and breathless"), not just the feeling. Full names a physical symptom ("gasping for
 * breath"): a stronger feeling word alone sounds the same as clear. Tweak by ear.
 */
const TAG: Record<string, [hint: string, clear: string, full: string]> = {
  happy: ["cheerful", "happy, bright and bouncy", "overjoyed, laughing, bursting with energy"],
  sad: ["a little sad", "sad, heavy and slow", "heartbroken, voice cracking, holding back sobs"],
  angry: ["irritated", "angry, hard and clipped", "furious, almost shouting, hard and clipped"],
  surprised: ["surprised", "astonished, quick and breathless", "stunned, gasping, words tumbling out"],
  afraid: ["nervous, a little shaky", "scared, shaky and breathless", "terrified, voice shaking, gasping for breath"],
  disgusted: ["put off", "disgusted, sneering", "revolted, gagging, sneering"],
  contempt: ["dismissive", "contemptuous, cold and clipped", "scornful, cold, dripping with disdain"],
  confused: ["puzzled", "confused, hesitant", "baffled, stumbling over words, trailing off"],
  suspicious: ["wary", "suspicious, low and guarded", "deeply suspicious, hushed, every word measured"],
  worried: ["a little worried", "worried, tense and quick", "panicking, voice tight, rushing the words"],
  tired: ["a little tired", "tired, slow and heavy", "exhausted, yawning, words slurring"],
  pain: ["wincing", "in pain, strained", "in agony, groaning, through gritted teeth"],
};

/** "[cheerful] " at a quarter or half, "[happy, bright and bouncy] " at three quarters, "[overjoyed, …] " at full; "" for neutral or zero. */
export function emotionTag(emotion: string, intensity: number): string {
  const k = quantiseIntensity(intensity);
  const steps = TAG[emotion];
  if (!steps || k === 0) return "";
  return `[${steps[k <= 0.5 ? 0 : k < 1 ? 1 : 2]}] `;
}

/** The text sent to ElevenLabs: the visitor's line without brackets, after our emotion tag. */
export function spokenText(text: string, emotion: string, intensity: number): string {
  const line = text.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  return emotionTag(emotion, intensity) + line;
}

/** The speak route's emotion fields: allow-listed ids only; the tag is built here, never taken from the client. */
export const SpeakEmotion = z.object({
  emotion: z.enum(EMOTION_IDS).default(NEUTRAL),
  intensity: z.number().min(0).max(1).default(0),
});

const STRENGTH = ["", "slight", "moderate", "strong", "full"];

/** "happy (strong)" for the face description; "" when neutral. */
export function emotionWords(emotion: string, intensity: number): string {
  const k = quantiseIntensity(intensity);
  if (emotion === NEUTRAL || k === 0) return "";
  return `${LABELS.get(emotion) ?? emotion} (${STRENGTH[Math.round(k * 4)]})`;
}

/** How each emotion is said in the Voice Design prompt: the feeling and how it sounds (the same delivery as the audio tags). Tweak by ear. */
const VOICE: Record<string, string> = {
  happy: "joyful, bright and bouncy",
  sad: "sorrowful, heavy and slow, close to tears",
  angry: "angry and seething, hard and clipped",
  surprised: "astonished, quick and breathless",
  afraid: "frightened, shaky and breathless",
  disgusted: "disgusted and sneering",
  contempt: "contemptuous, cold and dismissive",
  confused: "puzzled, hesitant and uncertain",
  suspicious: "suspicious, low and guarded",
  worried: "worried, tense and anxious",
  tired: "tired and drowsy, slow and low on energy",
  pain: "in pain, strained, speaking through gritted teeth",
};
const DEGREE = ["", "faintly", "somewhat", "clearly", "intensely"];

/** "clearly angry and seething" for the Voice Design prompt; "" when neutral. */
export function emotionVoice(emotion: string, intensity: number): string {
  const k = quantiseIntensity(intensity);
  if (emotion === NEUTRAL || k === 0) return "";
  return `${DEGREE[Math.round(k * 4)]} ${VOICE[emotion] ?? LABELS.get(emotion) ?? emotion}`;
}
