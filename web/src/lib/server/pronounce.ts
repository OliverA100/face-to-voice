/**
 * The phonemes of a line's words, for the browser's mouth (lib/lipsync/phonemes.ts): the CMU Pronouncing Dictionary
 * (src/data/phonemes.json, written by scripts/phonemes.ts; BSD-2, NOTICE) stays here on the server, and each spoken line
 * is sent with just its own words as a first NDJSON line, {"phonemes": {word: "HH AH0 L OW1", …}}.
 */
import "server-only";

import dictionary from "@/data/phonemes.json";
import { spokenWords } from "@/lib/lipsync/phonemes";

const DICT = dictionary as Record<string, string>;

/** { word: phonemes } for every word of `text` the dictionary knows (numbers as they are said, tags left out). */
export function phonemesFor(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of spokenWords(text)) if (DICT[w]) out[w] = DICT[w];
  return out;
}

/** The speech stream with the line's phonemes in front: one NDJSON line the player reads before the audio. */
export function withPhonemes(stream: ReadableStream<Uint8Array>, text: string): ReadableStream<Uint8Array> {
  const head = new TextEncoder().encode(JSON.stringify({ phonemes: phonemesFor(text) }) + "\n");
  const reader = stream.getReader();
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
