/**
 * Decodes .strands.bin files off the main thread (lib/strandsDecode.ts; lib/groom.ts decodeStrands asks), and ties the
 * decoded style to the skin when asked (lib/skinTie.ts): the skin's rest positions come once per registration (`key`).
 */
import { type SkinGrid, skinGrid, type StyleTies, tieStyle, type TieWanted } from "./skinTie";
import { decodeStrandsHere } from "./strandsDecode";

export type ToStrandsWorker = {
  id: number;
  gz: ArrayBuffer;
  tie?: { skin: { key: number; rest?: Float32Array; m: number[] }; wanted: TieWanted };
};
export type FromStrandsWorker =
  | { id: number; n: number; p: number; positions: Float32Array; shade: Float32Array; ties?: StyleTies; skinKey?: number }
  | { id: number; error: string };

let skin: { key: number; grid: SkinGrid } | null = null;

self.onmessage = async (e: MessageEvent<ToStrandsWorker>) => {
  const { id, gz, tie } = e.data;
  try {
    const s = await decodeStrandsHere(gz);
    if (tie?.skin.rest) skin = { key: tie.skin.key, grid: skinGrid(tie.skin.rest, tie.skin.m) };
    const ties = tie && skin?.key === tie.skin.key ? tieStyle(s.positions, s.n, s.p, skin.grid, tie.wanted) : undefined;
    const buffers = [s.positions.buffer, s.shade.buffer];
    for (const t of ties ? [ties.roots, ties.tips, ties.points] : []) if (t) buffers.push(t.idx.buffer, t.wts.buffer);
    (self as unknown as Worker).postMessage({ id, ...s, ties, skinKey: ties ? skin!.key : undefined } satisfies FromStrandsWorker, buffers);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies FromStrandsWorker);
  }
};
