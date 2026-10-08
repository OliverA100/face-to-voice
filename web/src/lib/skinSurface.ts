/**
 * The head's skin as a surface other pieces can follow: its mesh, the transform from its own (quantised) space to the
 * head's space in metres, its live morph offsets, and a notice whenever the CPU normal refresher recomputes its shape
 * (face sliders, Random face). Strands (lib/groom.ts) move their roots with it, and the glasses refit on the notice
 * (lib/glassesFit.ts). Head.tsx binds it.
 */
import { Matrix4, type Mesh } from "three";

import { headSpaceMatrix } from "@/lib/age";
import type { NormalRefresher } from "@/lib/morphs/normals";
import { morphs } from "@/lib/morphs/store";

export const skinSurface = {
  mesh: null as Mesh | null,
  refresher: null as NormalRefresher | null,
  /** skin mesh space → head space (metres, GNM template frame) */
  toHead: new Matrix4(),
};

const listeners = new Set<() => void>();

/** Called when the skin's shape changed; read it with skinShape(). */
export function onSkinShape(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Rest and current positions of the skin, in its own space (3 floats per vertex), or null before the head loads. */
export function skinShape(): { rest: Float32Array; current: Float32Array } | null {
  const { mesh, refresher } = skinSurface;
  return mesh && refresher ? refresher.shapeOf(mesh) : null;
}

/** Keep `acc` at the live morph offsets of skin vertices `ids` (skin space, 3 floats each); `last` remembers the weights
 *  already added (start with an empty map and zeros). `weight`: what each target counts (default: everything shown
 *  now). False before the head loads. */
export function skinOffsets(ids: Int32Array, last: Map<string, number>, acc: Float32Array,
  weight: (target: string) => number = (t) => morphs.effective(t)): boolean {
  const { mesh, refresher } = skinSurface;
  return !!mesh && !!refresher && refresher.accumulateOffsets(mesh, ids, weight, last, acc);
}

export function bindSkinSurface(mesh: Mesh, refresher: NormalRefresher): () => void {
  skinSurface.mesh = mesh;
  skinSurface.refresher = refresher;
  headSpaceMatrix(mesh, skinSurface.toHead);
  const off = refresher.onRefresh((m) => {
    if (m === mesh) for (const fn of listeners) fn();
  });
  return () => {
    off();
    if (skinSurface.mesh === mesh) skinSurface.mesh = skinSurface.refresher = null;
  };
}
