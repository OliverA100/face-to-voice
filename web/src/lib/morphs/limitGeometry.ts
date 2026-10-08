/**
 * The vertices the limiter tests (data/limits.json "vertices"), in head space (metres, the GNM template frame), for any
 * morph weights. Positions come from the morph targets the app already holds on the CPU (NormalRefresher.sample), so
 * the limiter downloads nothing but vertex indices.
 *
 * Each tested vertex is a (part, index) in head.glb. Skin, teeth, gums, tongue: mesh space → head space through the
 * nodes above the mesh (dequantisation). Eyes: the eye meshes hang off their pivot node, which the app moves with the
 * face (Head.tsx, manifest identity_pivot_basis), so the limiter adds that pivot itself: the limits are about the
 * resting face, gaze rotation is left out.
 */
import { Matrix4, type Mesh, type Object3D } from "three";

import { manifest } from "@/lib/data";
import { eyePivots, placePart } from "@/lib/morphs/limitPositions";
import type { NormalRefresher } from "@/lib/morphs/normals";

const EYE_NODES = ["left_eye", "right_eye"] as const;

type Group = { mesh: Mesh; ids: Int32Array; slots: Int32Array; m: Float32Array; eye: number; scratch: Float32Array };

export class LimitGeometry {
  readonly count: number;
  private readonly groups: Group[] = [];
  private readonly pivot = EYE_NODES.map((n) => manifest.nodes[n].pivot);
  private readonly basis = EYE_NODES.map((n) => Object.entries(manifest.nodes[n].identity_pivot_basis));

  constructor(
    private readonly refresher: NormalRefresher,
    meshes: Mesh[],
    parts: string[],
    vertices: { part: number[]; index: number[] },
  ) {
    this.count = vertices.part.length;
    parts.forEach((name, pi) => {
      const mesh = meshes.find((m) => (m.parent?.name || m.name) === name);
      if (!mesh) throw new Error(`limits.json: no mesh for part ${name}`);
      const slots: number[] = [];
      const ids: number[] = [];
      vertices.part.forEach((p, k) => {
        if (p === pi) {
          slots.push(k);
          ids.push(vertices.index[k]);
        }
      });
      // parts.py: sclera_L, iris_L … hang off left_eye; …_R off right_eye
      const eye = /^(sclera|iris|pupil|cornea)_[LR]$/.test(name) ? (name.endsWith("_L") ? 0 : 1) : -1;
      this.groups.push({ mesh, ids: Int32Array.from(ids), slots: Int32Array.from(slots), m: toNode(mesh, eye >= 0 ? EYE_NODES[eye as 0 | 1] : "head"), eye, scratch: new Float32Array(ids.length * 3) });
    });
  }

  /**
   * Head-space positions of every tested vertex into `out` (3 floats each). `weight(target)` = morph weight; with
   * `rest` false, only the change Σ weight · delta (a direction, pivot movement included) is written. `pivots`, if
   * given, gets the two eye pivots (6 floats; their change when `rest` is false).
   */
  positions(weight: (target: string) => number, out: Float32Array, rest = true, pivots?: Float32Array): boolean {
    const piv = eyePivots(this.pivot, this.basis, weight, rest);
    if (pivots) pivots.set([...piv[0], ...piv[1]]);
    for (const g of this.groups) {
      if (!this.refresher.sample(g.mesh, g.ids, weight, g.scratch, rest)) return false;
      placePart(g.slots, g.m, g.eye >= 0 ? piv[g.eye] : [0, 0, 0], g.scratch, out, rest);
    }
    return true;
  }

  /**
   * The same vertices for a copy of this class in a worker (lib/morphs/capsWorker.ts): per part, the slots, the matrix,
   * the eye, the rest positions and the order its targets are summed in (the mesh's, so the sums match bit for bit).
   * Read through the refresher like positions() does. Null if a mesh is not registered.
   */
  layout(): CapsLayout | null {
    const groups: CapsLayout["groups"] = [];
    for (const g of this.groups) {
      const rest = new Float32Array(g.ids.length * 3);
      if (!this.refresher.sample(g.mesh, g.ids, () => 0, rest, true)) return null;
      groups.push({ slots: g.slots, m: g.m, eye: g.eye, rest });
    }
    return { count: this.count, groups, pivot: this.pivot, basis: this.basis, order: this.targetOrder() };
  }

  /** Each part's targets in the order positions() adds them (it changes when head.extra.glb appends targets). */
  targetOrder(): string[][] {
    return this.groups.map((g) => Object.keys(g.mesh.morphTargetDictionary ?? {}));
  }

  /** One target's change per tested vertex (per part; `rest` false with weight 1 = the delta itself, exactly). */
  deltas(target: string): Float32Array[] {
    return this.groups.map((g) => {
      const out = new Float32Array(g.ids.length * 3);
      this.refresher.sample(g.mesh, g.ids, (t) => (t === target ? 1 : 0), out, false);
      return out;
    });
  }
}

/** What capsWorker.ts needs to rebuild positions() off the main thread. */
export type CapsLayout = {
  count: number;
  groups: { slots: Int32Array; m: Float32Array; eye: number; rest: Float32Array }[];
  pivot: number[][];
  basis: [string, number[]][][];
  order: string[][];
};

/** Mesh space → the space of the named ancestor node (its own transform not included). */
function toNode(mesh: Mesh, stop: string): Float32Array {
  const out = new Matrix4();
  for (let o: Object3D | null = mesh; o && o.name !== stop; o = o.parent) {
    o.updateMatrix();
    out.premultiply(o.matrix);
  }
  return Float32Array.from(out.elements);
}
