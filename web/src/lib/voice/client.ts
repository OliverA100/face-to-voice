/** Browser-side calls to our own API routes (never to ElevenLabs or Anthropic directly). */
import { quantiseFace } from "@/lib/voice/faceSignature";
import { currentLook } from "@/lib/look";
import { morphs } from "@/lib/morphs/store";
import { sliderFor, toUi } from "@/lib/morphs/travel";

export type Presentation = "neutral" | "feminine" | "masculine";

export interface DescriptionFields {
  presentation: Presentation; ageRange: string; character: string; build: string; energy: string; pacing: string; pitch: string;
  mood1: string; mood2: string; accent: string; accentStrength: string; ethnicity: string; persona: string; timbre: string;
  quirk: string; line: string; emotion: string; emotionIntensity: number;
}
export interface Preview { generatedVoiceId: string; url: string; durationSecs: number }
/** The Voice Design request behind a voice (server: VoiceRecipe in lib/server/voice.ts). Re-running it gives a similar voice. */
export interface VoiceRecipe {
  voiceDescription: string; text: string; seed: number;
  modelId: string; guidanceScale: number; loudness: number; outputFormat: string;
}
export interface DesignResult {
  faceKey: string; descKey: string; fields: DescriptionFields; presentation: Presentation;
  description: string; previews: Preview[]; voiceId: string | null;
  chosenIndex: number | null; // the preview voiceId was saved from (when voiceId is set)
  studioFallback: boolean; // voiceId is a studio stand-in, not one of the previews
  recipe: VoiceRecipe;
  cached: { description: boolean; previews: boolean };
}
export interface SelectResult { voiceId: string; saved: boolean; chosenIndex?: number; message?: string }

export class VoiceApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    // Network failure, or a wrapper (bot protection) rejecting with a non-Error value.
    console.warn("[voice] request failed:", e instanceof Error ? e.message : e);
    throw new VoiceApiError("network", "Couldn't reach the server. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) throw new VoiceApiError(data.error ?? "upstream", data.message ?? "Something went wrong. Please try again.", res.status);
  return data;
}

/**
 * The sliders as the panel shows them: −1 … +1 per slider, the average face at 0 (lib/morphs/travel.ts). This is
 * what the server sees, so "+1" always means "as far as this slider goes", whatever morph weight that end is.
 */
function sliderPositions(): Record<string, number> {
  return Object.fromEntries(Object.entries(morphs.snapshot()).map(([t, v]) => {
    const def = sliderFor(t);
    return [t, def ? toUi(def, v) : v];
  }));
}

/**
 * The face as the design cache sees it (lib/voice/faceSignature.ts): equal → "Find a new voice" would find the same
 * voices. Without the cursor follow's head turn: moving the mouse does not change the face (or flicker the button).
 */
export function currentFaceSignature(): string {
  return JSON.stringify(quantiseFace(sliderPositions(), currentLook(false)));
}

export function requestDesign(image: string): Promise<DesignResult> {
  return post<DesignResult>("/api/voice/design", { image, weights: sliderPositions(), look: currentLook() });
}

/** `generatedVoiceId`: the preview the visitor heard (the server refuses it if the voices were designed again since). */
export function requestSelect(descKey: string, previewIndex: number, generatedVoiceId?: string): Promise<SelectResult> {
  return post<SelectResult>("/api/voice/select", { descKey, previewIndex, generatedVoiceId });
}
