/**
 * The voice routes' replies, shared by the server (lib/server/voice.ts) and the browser (lib/voice/client.ts), so a field
 * added on one side reaches the other. Types only: importing it costs the browser nothing.
 */
import type { DescriptionFields, Presentation } from "@/lib/server/prompt";

export type { DescriptionFields, Presentation };

export interface Preview {
  generatedVoiceId: string;
  url: string;
  durationSecs: number;
}

/** Everything sent to Voice Design for this voice, for the export. Re-running it gives a similar voice, not the same one. */
export interface VoiceRecipe {
  voiceDescription: string;
  text: string;
  seed: number;
  modelId: string;
  guidanceScale: number;
  loudness: number;
  outputFormat: string;
}

/** POST /api/voice/design (and /recast). */
export interface DesignResult {
  faceKey: string;
  descKey: string;
  fields: DescriptionFields;
  presentation: Presentation;
  description: string;
  previews: Preview[];
  voiceId: string | null;
  chosenIndex: number | null; // which preview voiceId was saved from, when voiceId is set
  savedTakes: number[]; // the previews that already have a saved voice (choosing them again is free)
  studioFallback: boolean; // voiceId is a studio stand-in, not one of these previews
  recipe: VoiceRecipe;
  cached: { description: boolean; previews: boolean };
}

/** POST /api/voice/select. */
export interface SelectResult {
  voiceId: string;
  saved: boolean; // false when a studio fallback voice was used
  chosenIndex?: number; // the preview the voice came from (another visitor's pick if they saved this voice first)
  message?: string;
}
