/**
 * Strands follow the face (lib/groom.ts buildGroom): every root is tied to its three nearest skin vertices, and every
 * frame the skin's live morph offsets there (lib/skinSurface.ts) move the whole strand. Brows also follow the face's
 * shape at every point (followShapePoints); lashes turn away from skin the shape brings towards them (followSkin).
 */
import { type DataTexture, Matrix3, type Matrix4 } from "three";

import { sliders } from "@/lib/data";
import { morphs } from "@/lib/morphs/store";
import { skinOffsets, skinShape, skinSurface } from "@/lib/skinSurface";
import { skinGrid, type SkinGrid, type Tie, tiePoints } from "@/lib/skinTie";

/** A Map that notes whether set() was called since `changed` was last cleared (which morph weights moved this frame). */
class SetWatch<K, V> extends Map<K, V> {
  changed = false;
  set(key: K, value: V): this {
    this.changed = true;
    return super.set(key, value);
  }
}

/** Shape targets (identity and Shape sliders): what a lash's shape turn follows, never blinks or expressions. */
const SHAPE = new Set(sliders.sliders.filter((d) => d.kind === "identity" || d.kind === "semantic").map((d) => d.target));
const shapeWeight = (t: string) => (SHAPE.has(t) ? morphs.effective(t) : 0);
const yz = (y: number, z: number) => Math.atan2(y, z); // a direction's angle about the head's x axis (the lash turn)

/** The rest skin in head space, bucketed in a 1 cm grid (lib/skinTie.ts): the same for every piece tied to it (hair,
 *  brows, lashes and beard attach together on a Random character), so built once per skin registration. Read only. */
let skinGridCache: { rest: Float32Array; m: string; grid: SkinGrid } | null = null;
function restSkinGrid(rest: Float32Array, m: Matrix4): SkinGrid {
  const key = m.elements.join();
  if (skinGridCache?.rest !== rest || skinGridCache.m !== key) skinGridCache = { rest, m: key, grid: skinGrid(rest, m.elements) };
  return skinGridCache.grid;
}

type SkinTie = Tie & { head: Float32Array; lin: Matrix3 };

/**
 * Tie points (head space) to their three nearest rest skin vertices (lib/skinTie.ts), or take the tie the strands worker
 * made while decoding (`made`, for the same skin). Also the rest skin in head space and the skin → head direction
 * matrix. Null before the head loads.
 */
function tieToSkin(pts: Float32Array, made?: Tie): SkinTie | null {
  const shape = skinShape();
  if (!shape) return null;
  const m = skinSurface.toHead;
  const grid = restSkinGrid(shape.rest, m);
  return { ...(made ?? tiePoints(pts, grid)), head: grid.head, lin: new Matrix3().setFromMatrix4(m) };
}

/** The distinct skin vertices of `idx` (`uniq`) and each entry's place among them (`slot`): neighbouring points share
 *  their skin, so its offsets are summed once per vertex instead of once per point that uses it (same values). */
function uniqueSkin(idx: Int32Array): { uniq: Int32Array; slot: Int32Array } {
  const at = new Map<number, number>();
  const slot = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let u = at.get(idx[i]);
    if (u === undefined) at.set(idx[i], (u = at.size));
    slot[i] = u;
  }
  return { uniq: Int32Array.from(at.keys()), slot };
}

/**
 * Brows (`shapeFollow`): hairs lie on the skin, and a face's shape bends the skin under a hair, not only where its root
 * is (a low brow folds the upper lid over the brow's lower hairs, a deep-set eye rolls the brow ridge). Every point is
 * tied to the skin under it, and gets the SHAPE's offset there minus the shape's offset at its root (`out`, per point;
 * the root's own offset, with blinks and expressions, still moves the whole hair). So a hair keeps its distance from
 * its own skin; blinks and expressions move it as before. Live: follows a slider drag.
 */
export function followShapePoints(points: Float32Array, p: number, out: { tex: DataTexture; data: Float32Array }, made?: Tie) {
  const count = points.length / 3;
  let tie: ReturnType<typeof tieToSkin> = null;
  let shared: ReturnType<typeof uniqueSkin> | null = null; // every point's three skin vertices, once each
  let offs: Float32Array | null = null;
  const last = new Map<string, number>();
  const seen = new Map<string, number>(); // shape weights at the last write
  const d = new Float32Array(count * 3);
  let rest: Float32Array | null = null; // the skin registration the sums belong to
  const update = () => {
    tie ??= tieToSkin(points, made);
    if (!tie) return;
    shared ??= uniqueSkin(tie.idx);
    offs ??= new Float32Array(shared.uniq.length * 3);
    // head.extra.glb re-registers the skin with its targets (a new rest array). The semantic sliders' weights didn't
    // change, so nothing below would notice: start the sums again, or brows that attached first never follow them.
    const skin = skinShape();
    if (skin && skin.rest !== rest) {
      rest = skin.rest;
      seen.clear();
      last.clear();
      offs.fill(0);
    }
    let changed = false;
    for (const t of SHAPE) {
      const w = morphs.effective(t);
      if ((seen.get(t) ?? 0) !== w) {
        seen.set(t, w);
        changed = true;
      }
    }
    if (!changed || !skinOffsets(shared.uniq, last, offs, shapeWeight)) return;
    const e = tie.lin.elements;
    for (let q = 0; q < count; q++) {
      let x = 0, y = 0, z = 0;
      for (let c = 0; c < 3; c++) {
        const j = shared.slot[q * 3 + c] * 3, w = tie.wts[q * 3 + c];
        x += w * offs[j];
        y += w * offs[j + 1];
        z += w * offs[j + 2];
      }
      d[q * 3] = e[0] * x + e[3] * y + e[6] * z;
      d[q * 3 + 1] = e[1] * x + e[4] * y + e[7] * z;
      d[q * 3 + 2] = e[2] * x + e[5] * y + e[8] * z;
    }
    for (let q = 0; q < count; q++) {
      const r = q - (q % p); // the hair's root
      for (let a = 0; a < 3; a++) out.data[q * 4 + a] = d[q * 3 + a] - d[r * 3 + a];
    }
    out.tex.needsUpdate = true;
  };
  return update;
}

/**
 * Tie every root (head space) to its three nearest rest skin vertices; the returned update (every frame) moves it with
 * them. Lashes (`tips`): each tip's nearest skin is tied the same way, and when the face's SHAPE brings that skin
 * towards the lash (a deep-set eye's overhang, a low brow) the lash turns with it, away from the skin, never towards
 * it (out.data w), by at most `limits` (GROOM's shapeTurnMax / shapeTurnMinMm, read every frame). Blinks and
 * expressions keep their own turns (the eye-follow turn and the baked lid fix).
 */
export function followSkin(
  roots: Float32Array,
  out: { tex: DataTexture; data: Float32Array },
  limits: { shapeTurnMax: number; shapeTurnMinMm: number },
  tips?: Float32Array,
  made?: { roots: Tie; tips?: Tie },
): () => void {
  const n = roots.length / 3;
  const idx = new Int32Array(n * 3);
  const wts = new Float32Array(n * 3);
  const tipIdx = tips ? new Int32Array(n * 3) : null;
  const tipWts = tips ? new Float32Array(n * 3) : null;
  const under = tips ? new Float32Array(n * 3) : null; // the rest skin point under each tip (head space)
  const above = tips ? new Int8Array(n) : null; // 1: that skin is above the lash (upper lid), 0: below (lower lid)
  let bound = false;
  const lin = new Matrix3();

  const bind = (): boolean => {
    const r = tieToSkin(roots, made?.roots);
    if (!r) return false;
    idx.set(r.idx);
    wts.set(r.wts);
    lin.copy(r.lin);
    if (tips && tipIdx && tipWts && under && above) {
      const t = tieToSkin(tips, made?.tips)!;
      tipIdx.set(t.idx);
      tipWts.set(t.wts);
      for (let s = 0; s < n; s++) {
        for (let a = 0; a < 3; a++) {
          let u = 0;
          for (let q = 0; q < 3; q++) u += tipWts[s * 3 + q] * t.head[tipIdx[s * 3 + q] * 3 + a];
          under[s * 3 + a] = u;
        }
        const ry = roots[s * 3 + 1], rz = roots[s * 3 + 2];
        above[s] = yz(under[s * 3 + 1] - ry, under[s * 3 + 2] - rz) > yz(tips[s * 3 + 1] - ry, tips[s * 3 + 2] - rz) ? 1 : 0;
      }
    }
    bound = true;
    return true;
  };

  /** Every frame: the bound skin vertices' current morph offsets, straight from the morph store, once per skin vertex
   *  (uniqueSkin). */
  let offs: Float32Array | null = null;
  let uniq: Int32Array | null = null;
  let slot: Int32Array | null = null;
  const lastWeights = new SetWatch<string, number>();
  // lashes: the shape-only offsets of the roots' and tips' skin
  let shapeRoot: Float32Array | null = null;
  let shapeTip: Float32Array | null = null;
  const lastShapeRoot = new SetWatch<string, number>();
  const lastShapeTip = new SetWatch<string, number>();
  let written = false; // the texture holds this groom's offsets (written once, then only when a weight moved)
  const shapeTurn = () => {
    if (!tipIdx || !tipWts || !under || !above) return;
    shapeRoot ??= new Float32Array(idx.length * 3);
    shapeTip ??= new Float32Array(idx.length * 3);
    if (!skinOffsets(idx, lastShapeRoot, shapeRoot, shapeWeight) || !skinOffsets(tipIdx, lastShapeTip, shapeTip, shapeWeight)) return;
    if (written && !lastShapeRoot.changed && !lastShapeTip.changed) return; // the shape didn't move: same turns
    const e = lin.elements;
    for (let s = 0; s < n; s++) {
      // y and z (head space) of how far the shape moved the root and the skin under the tip
      let ry = 0, rz = 0, uy = 0, uz = 0;
      for (let q = 0; q < 3; q++) {
        const j = (s * 3 + q) * 3, w = wts[s * 3 + q], wt = tipWts[s * 3 + q];
        ry += w * (e[1] * shapeRoot[j] + e[4] * shapeRoot[j + 1] + e[7] * shapeRoot[j + 2]);
        rz += w * (e[2] * shapeRoot[j] + e[5] * shapeRoot[j + 1] + e[8] * shapeRoot[j + 2]);
        uy += wt * (e[1] * shapeTip[j] + e[4] * shapeTip[j + 1] + e[7] * shapeTip[j + 2]);
        uz += wt * (e[2] * shapeTip[j] + e[5] * shapeTip[j + 1] + e[8] * shapeTip[j + 2]);
      }
      const dy = under[s * 3 + 1] - roots[s * 3 + 1], dz = under[s * 3 + 2] - roots[s * 3 + 2];
      if (Math.hypot(dy, dz) < limits.shapeTurnMinMm / 1000) continue; // stays 0
      // how the root → skin-under-the-tip direction turned (wrapped to ±π), at most shapeTurnMax, only away from that skin
      let turn = yz(dy + uy - ry, dz + uz - rz) - yz(dy, dz);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const max = (limits.shapeTurnMax * Math.PI) / 180;
      out.data[s * 4 + 3] = above[s] ? Math.max(-max, Math.min(0, turn)) : Math.min(max, Math.max(0, turn));
    }
  };
  return () => {
    if (!bound && !bind()) return;
    if (!uniq || !slot) ({ uniq, slot } = uniqueSkin(idx));
    offs ??= new Float32Array(uniq.length * 3);
    lastWeights.changed = lastShapeRoot.changed = lastShapeTip.changed = false;
    if (!skinOffsets(uniq, lastWeights, offs)) return;
    shapeTurn();
    // no weight moved since the last frame (most idle frames, or a second render in the same frame): same texture
    if (written && !lastWeights.changed && !lastShapeRoot.changed && !lastShapeTip.changed) return;
    written = true;
    const e = lin.elements; // column-major 3×3: skin space → head space directions
    for (let s = 0; s < n; s++) {
      let dx = 0, dy = 0, dz = 0;
      for (let q = 0; q < 3; q++) {
        const j = slot[s * 3 + q] * 3, w = wts[s * 3 + q];
        dx += w * offs[j];
        dy += w * offs[j + 1];
        dz += w * offs[j + 2];
      }
      out.data[s * 4] = e[0] * dx + e[3] * dy + e[6] * dz;
      out.data[s * 4 + 1] = e[1] * dx + e[4] * dy + e[7] * dz;
      out.data[s * 4 + 2] = e[2] * dx + e[5] * dy + e[8] * dz;
    }
    out.tex.needsUpdate = true;
  };
}
