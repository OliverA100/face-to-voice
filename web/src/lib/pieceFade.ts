/**
 * Cross-fading the hair and add-ons (Random character, Reset) without making anything see-through.
 *
 * Half-transparent hair shows its structure (bands, gaps, overlaps: it reads patchy), so the pieces never fade
 * themselves. Instead, while a fade runs, the head is rendered twice per frame
 * (components/scene/PieceFadeRender.tsx): once with the leaving pieces, once with the arriving ones, both fully
 * opaque, both live (morph, idle motion, lip-sync), then the first image is laid over the second at 1 − t. The face
 * is the same in both, so only the pieces change, as an even per-pixel cross-fade.
 *
 * Flow: openPieceFade() starts a batch; hair.ts / addons.ts hand each swap to swapPiece() (the new piece waits,
 * hidden, in the "after" image); runPieceFade() plays it; at the end the leaving pieces are removed. Plain module
 * state, read by the render loop every frame (no React).
 *
 * The skin is in both images, but hair and beards also paint it (the scalp tint, stubble: lib/skinShader.ts). So the
 * "before" image draws the skin as it was when the batch opened (skinBefore), and a leaving piece's paint comes off
 * the live skin, the "after" image, as soon as it joins the batch (its userData.skinOff). Pieces drawn under another
 * node (the shells beard is a child of the skin) list those meshes in userData.fadeAlso.
 */
import gsap from "gsap";
import type { Object3D } from "three";

import { MOTION } from "@/lib/motion";
import { type SkinPieces, snapshotSkinPieces } from "@/lib/skinShader";

/** Tweak freely. */
export const PIECE_FADE = {
  ease: MOTION.ease.crossfade,
};

type Leaving = { node: Object3D; remove: () => void };

export const pieceFade = {
  leaving: [] as Leaving[], // drawn only in the "before" image, removed when the fade ends
  arriving: [] as Object3D[], // drawn only in the "after" image, then on the head for good
  open: false, // a batch is collecting swaps
  running: false,
  t: 0, // 0 = before, 1 = after
  skinBefore: null as SkinPieces | null, // the skin's scalp tint and stubble for the "before" image
};

/** Every node a piece draws with: its own subtree plus what it keeps elsewhere (userData.fadeAlso). */
export function pieceNodes(node: Object3D, fn: (o: Object3D) => void): void {
  node.traverse(fn);
  for (const extra of (node.userData.fadeAlso as Object3D[] | undefined) ?? []) extra.traverse(fn);
}

let tween: gsap.core.Tween | null = null;

/** Start collecting swaps (Random character, Reset). Ends any fade still running first. */
export function openPieceFade(): void {
  finishPieceFade();
  pieceFade.open = true;
  pieceFade.skinBefore = snapshotSkinPieces();
}

/**
 * Hand a swap to the open batch: `leaving` stays drawn in the "before" image until the fade ends, then `remove` takes
 * it off; `arriving` is drawn in the "after" image. Returns false when no batch is collecting (the caller swaps at once).
 */
export function swapPiece(leaving: Object3D | null, arriving: Object3D | null, remove: () => void): boolean {
  if (!pieceFade.open || pieceFade.running) return false;
  if (leaving) {
    pieceFade.leaving.push({ node: leaving, remove });
    (leaving.userData.skinOff as (() => void) | undefined)?.(); // off the "after" image's skin now
  }
  if (arriving) pieceFade.arriving.push(arriving);
  return true;
}

/** Play the batch over `seconds`. Resolves when it has finished. */
export function runPieceFade(seconds: number): Promise<void> {
  if (!pieceFade.leaving.length && !pieceFade.arriving.length) {
    pieceFade.open = false;
    return Promise.resolve();
  }
  pieceFade.running = true;
  pieceFade.t = 0;
  return new Promise((done) => {
    tween = gsap.to(pieceFade, {
      t: 1,
      duration: seconds,
      ease: PIECE_FADE.ease,
      onComplete: () => {
        finishPieceFade();
        done();
      },
    });
  });
}

/** End the batch now: the leaving pieces go, the arriving ones stay, everything back on the normal layer. */
export function finishPieceFade(): void {
  tween?.kill();
  tween = null;
  for (const node of pieceFade.arriving) pieceNodes(node, (o) => o.layers.set(0));
  for (const { node, remove } of pieceFade.leaving) {
    pieceNodes(node, (o) => o.layers.set(0)); // a cached hair style comes back on the normal layer
    remove();
  }
  pieceFade.leaving = [];
  pieceFade.arriving = [];
  pieceFade.open = false;
  pieceFade.running = false;
  pieceFade.t = 0;
  pieceFade.skinBefore = null;
}
