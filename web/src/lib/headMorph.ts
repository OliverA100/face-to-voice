/**
 * The loader's "morph" reveal (components/ui/loader/engine.ts) and the 3D head (components/scene/Head.tsx) meet here:
 * the loader tweens `headMorph.t` from 0 (every head vertex pulled onto the loader's bubble) to 1 (the head as it is),
 * and the scene reads it every frame (lib/morphShader.ts). No three.js in here: the loader is in the first-load bundle.
 */

/** A circle on screen, in viewport pixels: where the loader's bubble is. */
export interface ScreenCircle {
  x: number;
  y: number;
  r: number;
  clock?: number; // the loader sphere's clock (its rainbow film drifts with it), so the 3D bubble starts on the same colours
  drift?: number; // …where its noise is (the bumps' pattern) …
  turn?: number; // …and how far it has turned (radians about the vertical), so the bumps line up too
  since?: number; // s since it reached the finish (the morph reveal picks up the loader's run back from there)
}

/**
 * Which morph: "pieces" (a style-lab option: the face forms first, region by region, the hair grows from its roots) or
 * "swing" (E: the loader's own last swing, bubble → blob, landing on the face: one curve drives everything).
 */
export type MorphStyle = "pieces" | "swing";

/**
 * 1 = no morph (every normal frame). The loader writes it during the reveal. `yaw` / `pitch`: radians the head is
 * turned away while it forms (lib/morphShader.ts SWING.turnIn), added to the pose by IdleLife; 0 at rest.
 */
export const headMorph: { t: number; style: MorphStyle; yaw: number; pitch: number } = { t: 1, style: "swing", yaw: 0, pitch: 0 };

type Begin = (bubble: ScreenCircle, style: MorphStyle) => void;
let begin: Begin | null = null;
let prepare: (() => void) | null = null;

/**
 * The scene registers how to start a morph from the bubble (Head.tsx), and how to get ready for one (compile what it
 * needs in the background, as the head looks now); returns the unregister.
 */
export function registerMorph(fn: Begin, ready?: () => void): () => void {
  begin = fn;
  prepare = ready ?? null;
  return () => {
    if (begin === fn) begin = prepare = null;
  };
}

/** The reveal is coming (the sphere is settling on its finish): compile the morph's shaders now, off the hand-over. */
export function prepareMorph(): void {
  prepare?.();
}

/** Whether a head is on the page that can morph (else the loader falls back to another reveal). */
export const canMorph = (): boolean => begin !== null;

/** Place the bubble in the scene, around the face; `headMorph.t` then drives it. */
export function beginMorph(bubble: ScreenCircle, style: MorphStyle): void {
  headMorph.style = style;
  begin?.(bubble, style);
}
