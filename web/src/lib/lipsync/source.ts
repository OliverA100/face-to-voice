/**
 * Which speech the mouth follows: a live conversation's voice while one is playing (lib/lipsync/live.ts registers it),
 * otherwise the speech player. LipSync.tsx asks every frame.
 */
import type { SpeechSource } from "./evaluator";
import { speechPlayer } from "./player";

let live: SpeechSource | null = null;

export function setLiveSpeech(source: SpeechSource | null): void {
  live = source;
}

/** The live conversation's source, if one is registered (debug handle, QA scripts). */
export const liveSpeech = (): SpeechSource | null => live;

export function activeSpeech(): SpeechSource {
  return live?.playing ? live : speechPlayer;
}
