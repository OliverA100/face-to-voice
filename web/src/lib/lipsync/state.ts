/** Shared per-frame lip-sync numbers (plain module state, written by LipSync, read by IdleLife and the overlay). */
import { emptyActivations, LIPSYNC } from "./evaluator";

export const lipsyncState = {
  active: false,
  activations: emptyActivations(),
  energy: 0, // 0..1 how open the mouth is right now, for a subtle speech nod
  clipTime: -1,
  leadMs: LIPSYNC.lead * 1000, // effective mouth lead over the audio clock (LIPSYNC.lead or ?lipsyncOffsetMs=)
  // A live conversation (lib/talk/face.ts), read by IdleLife:
  listening: 0, // 0..1 the visitor is talking and the character listens: slow small nods
  nod: 0, // 0..1 a single acknowledging nod as the character takes its turn
};
