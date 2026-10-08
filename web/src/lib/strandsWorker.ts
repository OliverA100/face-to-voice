/** Decodes .strands.bin files off the main thread (lib/strandsDecode.ts; lib/groom.ts decodeStrands asks). */
import { decodeStrandsHere } from "./strandsDecode";

export type ToStrandsWorker = { id: number; gz: ArrayBuffer };
export type FromStrandsWorker =
  | { id: number; n: number; p: number; positions: Float32Array; shade: Float32Array }
  | { id: number; error: string };

self.onmessage = async (e: MessageEvent<ToStrandsWorker>) => {
  const { id, gz } = e.data;
  try {
    const s = await decodeStrandsHere(gz);
    (self as unknown as Worker).postMessage({ id, ...s } satisfies FromStrandsWorker, [s.positions.buffer, s.shade.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies FromStrandsWorker);
  }
};
