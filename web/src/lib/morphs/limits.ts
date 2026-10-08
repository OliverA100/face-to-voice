/**
 * Limits: sliders may make any face that is not physically broken (pipeline: `uv run validate`).
 *
 * The limiter runs a small part of the pipeline's exact geometric checks on the vertices that can break
 * (data/limits.json, built and measured by pipeline/src/ftv_pipeline/validate/vlimits.py, which mirrors this file):
 *
 *   eyes      outer skin inside the visible eyeball (lids, brow, nose): closest point on the eye's triangles, deeper
 *             than on the average face by more than `eye_lids_hard_mm` anywhere, or by `eye_lids_mm` at
 *             `eye_lids_count` spots off the lid edge (both `eye_limiter_slack_mm` inside the exact check's values)
 *   crossings skin, or a tooth, through skin: the exact triangle/triangle test among the triangles that crossed in any
 *             broken face the pipeline found, or near one (contact the checks allow, like lip on lip, does not
 *             count). Measured by depth (how far a triangle really passes through the other: a graze of a few µm is 0);
 *             the limiter stops at `limiter_crossing_mm`, a little before the exact check's break.
 *   lips      one lip's inner edge past the other lip's outer edge
 *
 * Positions come from the morph targets the app already holds (lib/morphs/limitGeometry.ts). Positions are linear in
 * any one slider, so:
 *
 *  1. span(): when a slider is grabbed, how far it may go each way with every other slider where it is (bisection on
 *     that line). That becomes the end of its track (lib/morphs/travel.ts adaptiveTrack): it always drags to its end
 *     and never meets a wall; the end is as far as this face allows. The other sliders never move.
 *  2. caps(): when the shape settles, how far the blink, the current emotion and the mouth shapes may go on this face
 *     (0..1), never less than they go on the average face (GNM's own motion is not "broken"). Per frame the store just
 *     scales those layers (no work per frame).
 *  3. broken() / reach(): Random face checks a whole face and pushes its striking features only as far as they fit.
 */
import type { Weights } from "@/lib/data";
import limitsJson from "@/data/limits.json";

import { BLINK_STAGES, type LimitStore } from "./limitBasics";

import type { LimitGeometry } from "./limitGeometry";

// The small part the page needs before this module loads (lib/morphs/limiter.ts loads it after the head's first frame).
export { BLINK_STAGES, plainStore, REST_LAYERS, type LimitStore } from "./limitBasics";

/** Tweak freely. */
export const LIMITS = {
  steps: 10, // bisection steps when looking for a limit (each halves the uncertainty: 1/1024 of the slider)
  // An animation may cross skin this much deeper than it does on the average face: in close-up renders, lids and lips
  // 0.2–0.4 mm past the average face doing the same thing look identical to it.
  animToleranceMm: 0.5,
  blinkRetractMm: 4, // a blink may draw the eyeballs back this far, so the lids close over eyes that sit far forward
};

type Thresholds = {
  eye_lids_mm: number; eye_lids_hard_mm: number; eye_lids_count: number; eye_limiter_slack_mm: number;
  lips_cross_mm: number; limiter_crossing_mm: number; limiter_edge_tol: number; eye_through_mm?: number;
  eye_through_clearance_mm?: number;
};
export type LimitsDoc = {
  version: number;
  thresholds: Thresholds;
  parts: string[];
  vertices: { part: number[]; index: number[] };
  eyes: {
    skin: number[]; tris: number[]; k: number; base: number[]; edge: number[];
    // eye_through: outer skin triangles (vertex slots) eye points may pick, which are lid edge, how many each picks,
    // and the eye points themselves (the cornea included)
    through?: number[]; throughEdge?: number[]; thruK?: number; throughPts?: number[];
  }[];
  cross: { tris: number[]; inner: number[]; outer: number[]; zone: number[]; contact: number[] };
  lips: { up: number[]; lo: number[]; ls: number[]; li: number[] };
};

/** Depths per test on one face (eye and eye_through per point, pairs: crossing → its depth, lips: mm through). */
type Depths = { eye: number[][]; through: number[][]; pairs: Map<number, number>; lips: number };
/**
 * What an animation may break on the average face (it is allowed to do as much on any face). `rest`: this face at
 * rest; a point or crossing the animation takes no deeper than that (within REST_NOISE_MM) never counts, so a face that
 * sits near a limit at rest still animates what it can.
 */
type Ref = { eye: Float32Array[]; through: Float32Array[]; pairs: Map<number, number>; lips: number; rest?: Depths };
const REST_NOISE_MM = 0.05;

/** A test result: broken, and what broke (mouth / skin = the deepest crossing in mm). */
export type Verdict = { broken: boolean; eye: boolean; lips: boolean; mouth: number; skin: number };

/** Positions of the tested vertices and the two eye pivots (head space, metres). */
type Pose = { P: Float32Array; piv: Float32Array };

export class Limiter {
  readonly doc: LimitsDoc;
  private geom: LimitGeometry | null = null;
  private cur: Pose = pose(0);
  private line: Pose = pose(0); // a face without the dragged slider's own part
  private up: Pose = pose(0); // how it moves per unit above zero
  private down: Pose = pose(0); // … below zero
  private avg: Pose | null = null;
  /** Per eye: each tested skin vertex's k candidate eye triangles (vertex slots, n × k × 3), picked in attach(). */
  private eyeTri: Int32Array[] = [];
  /** eye_through per eye: visible eye points (slots), each one's thruK candidate skin triangles, lid-edge flags, base. */
  private thru: { pts: Int32Array; cand: Int32Array; tris: Int32Array; edge: Uint8Array; k: number; base: Float32Array<ArrayBufferLike> }[] = [];
  private readonly eyeSkin: Int32Array[];
  /** Per eye: every eye vertex slot (the cornea included), for drawEyesBack(). */
  private eyeSlots: Int32Array[] | null = null;
  private readonly crossTri: Int32Array;
  private cache: { slider: string; span: [number, number] } | null = null;
  private boxes = new Float32Array(0);
  /** crossings()' broad-phase grid: cell size (m, from the average face's triangles) and each triangle's cell range. */
  private cell = 0;
  private cells = new Int32Array(0);
  /** caps(): this face at rest, and each animation's average-face reference, kept while their positions are unchanged
   *  (one settle asks for every animation on the same face; a reference never depends on the face). Cleared on attach. */
  private restMemo: { P: Float32Array; piv: Float32Array; rest: Depths; eye: Float32Array[] }[] = [];
  private refMemo = new Map<string, { P: Float32Array; piv: Float32Array; ref: Omit<Ref, "rest">; thru: Limiter["thru"] }>();

  constructor(doc: LimitsDoc = limitsJson as unknown as LimitsDoc) {
    this.doc = doc;
    this.eyeSkin = doc.eyes.map((e) => Int32Array.from(e.skin));
    this.crossTri = Int32Array.from(doc.cross.tris);
  }

  get ready(): boolean {
    return this.geom !== null;
  }

  /** Head.tsx: the head's meshes are loaded (again after head.extra.glb adds the Shape targets); null on unmount. */
  attach(geom: LimitGeometry | null): void {
    this.geom = geom && this.doc.version === 2 ? geom : null;
    this.cache = null;
    this.avg = null;
    this.eyeTri = [];
    this.restMemo = [];
    this.refMemo.clear();
    this.cell = 0;
    const n = (geom?.count ?? 0) * 3;
    [this.cur, this.line, this.up, this.down] = [pose(n), pose(n), pose(n), pose(n)];
    if (this.geom) {
      this.avg = pose(n);
      this.geom.positions(() => 0, this.avg.P, true, this.avg.piv);
      this.eyeTri = this.doc.eyes.map((e, ei) => pickEyeTriangles(this.avg!, ei, this.eyeSkin[ei], Int32Array.from(e.tris), e.k));
      this.thru = this.doc.eyes.map((e, ei) => {
        const tris = Int32Array.from(e.through ?? []);
        const pts = Int32Array.from(new Set(e.throughPts ?? e.tris));
        const edge = new Uint8Array(tris.length / 3);
        for (const t of e.throughEdge ?? []) edge[t] = 1;
        const k = Math.min(e.thruK ?? 16, tris.length / 3);
        const th = { pts, cand: pickSkinTriangles(this.avg!, ei, pts, tris, k), tris, edge, k };
        return { ...th, base: this.throughDepths(this.avg!, ei, th) };
      });
    }
  }

  /** Move both eyeballs (their vertices and pivots) back along z by r metres. */
  private drawEyesBack(f: Pose, r: number): void {
    this.eyeSlots ??= this.doc.eyes.map((e) => Int32Array.from(new Set([...e.tris, ...(e.throughPts ?? [])]))); // (with the cornea)
    this.eyeSlots.forEach((slots, ei) => {
      for (const v of slots) f.P[v * 3 + 2] -= r;
      f.piv[ei * 3 + 2] -= r;
    });
  }

  /** Forget cached slider limits (another slider, a tween or a random face changed the face). */
  invalidate(): void {
    this.cache = null;
  }

  /** span() for `slider` on this face is already known (the caps worker computed it, lib/morphs/capsClient.ts): keep
   *  it as if span() had just run, so the drag's next grabs (a key press) find it cached. */
  primeSpan(slider: string, span: [number, number]): void {
    this.cache = { slider, span };
  }

  /** The store changed `target`: the dragged slider's own changes keep its cached limits, any other drops them. */
  changed(target: string): void {
    if (this.cache && this.cache.slider !== target) this.cache = null;
  }

  // --- the tests --------------------------------------------------------------------------------------------------

  /** Test a pose. `ref`: allowances for an animation (see caps). */
  test(f: Pose, ref?: Ref, fixed?: { still: Uint8Array; depth: Float32Array }[]): Verdict {
    const t = this.doc.thresholds;
    const slack = t.eye_limiter_slack_mm;
    let eye = false;
    this.doc.eyes.forEach((e, ei) => {
      const depth = this.eyeDepths(f, ei, fixed?.[ei]);
      const base = ref ? ref.eye[ei] : e.base;
      // an animation: no deeper than the average face doing the same, by more than the animation allowance
      const hard = ref ? Math.min(t.eye_lids_hard_mm, LIMITS.animToleranceMm) : t.eye_lids_hard_mm;
      let spots = 0;
      const restEye = ref?.rest?.eye[ei];
      for (let i = 0; i < depth.length; i++) {
        if (restEye && depth[i] <= restEye[i] + REST_NOISE_MM) continue; // no deeper than this face at rest
        const extra = depth[i] - base[i];
        if (extra > hard + slack) eye = true;
        else if (extra > t.eye_lids_mm + slack && !e.edge[i]) spots++;
      }
      if (spots >= t.eye_lids_count) eye = true;
    });
    // the eyeball poking out through the skin (not at the lid edge): seen at any depth, so only noise is allowed
    this.thru.forEach((th, ei) => {
      const depth = this.throughDepths(f, ei, th);
      const base = ref ? ref.through[ei] : th.base;
      const restThru = ref?.rest?.through[ei];
      for (let i = 0; i < depth.length; i++) {
        if (restThru && depth[i] <= restThru[i] + REST_NOISE_MM) continue;
        if (depth[i] - base[i] > (t.eye_through_mm ?? Infinity) + slack) eye = true;
      }
    });
    const through = this.lipsThrough(f.P);
    const lips = through > Math.max(t.lips_cross_mm, ref ? ref.lips : -Infinity) && !(ref?.rest && through <= ref.rest.lips + REST_NOISE_MM);
    const { mouth, skin } = this.crossings(f.P, ref?.pairs, ref?.rest?.pairs);
    // an animation (ref) is measured against the average face doing the same: a little deeper is never visible
    const cross = ref ? Math.max(t.limiter_crossing_mm, LIMITS.animToleranceMm) : t.limiter_crossing_mm;
    return { broken: eye || lips || Math.max(mouth, skin) > cross, eye, lips, mouth, skin };
  }

  private lipsThrough(P: Float32Array): number {
    const y = (ids: number[]) => ids.reduce((s, i) => s + P[i * 3 + 1], 0) / ids.length;
    const L = this.doc.lips;
    return Math.max(y(L.lo) - y(L.ls), y(L.li) - y(L.up)) * 1000;
  }

  /**
   * Per visible eye point of eye `ei`: how far (mm) it sticks out through the skin: the ray from the pivot through it
   * crosses one of its candidate skin triangles (not lid edge) inside the eye; 0 elsewhere (pipeline checks._eye_through).
   */
  private throughDepths(f: Pose, ei: number, th: { pts: Int32Array; cand: Int32Array; tris: Int32Array; edge: Uint8Array; k: number }): Float32Array {
    const P = f.P;
    const cx = f.piv[ei * 3], cy = f.piv[ei * 3 + 1], cz = f.piv[ei * 3 + 2];
    const out = new Float32Array(th.pts.length);
    const clear = (this.doc.thresholds.eye_through_clearance_mm ?? 0) / 1000; // skin this close shows the eye through
    for (let i = 0; i < th.pts.length; i++) {
      const v = th.pts[i] * 3;
      const vx = P[v] - cx, vy = P[v + 1] - cy, vz = P[v + 2] - cz;
      const L0 = Math.hypot(vx, vy, vz) || 1;
      const dx = vx / L0, dy = vy / L0, dz = vz / L0;
      const L = L0 + clear;
      let behind = -Infinity;
      for (let j = 0; j < th.k; j++) {
        const t = th.cand[i * th.k + j];
        if (th.edge[t]) continue; // lid edges rest on the eye: eye_lids' business
        const a = th.tris[t * 3] * 3, b = th.tris[t * 3 + 1] * 3, c = th.tris[t * 3 + 2] * 3;
        const hit = rayTriangle(dx, dy, dz, P[a] - cx, P[a + 1] - cy, P[a + 2] - cz, P[b] - cx, P[b + 1] - cy, P[b + 2] - cz, P[c] - cx, P[c + 1] - cy, P[c + 2] - cz);
        if (hit < L && hit > behind) behind = hit;
      }
      out[i] = behind > -Infinity ? (L - behind) * 1000 : 0;
    }
    return out;
  }

  /** Per tested skin vertex of eye `ei`: mm inside the visible eye (< 0 outside). */
  private eyeDepths(f: Pose, ei: number, fixed?: { still: Uint8Array; depth: Float32Array }): Float32Array {
    const P = f.P;
    const e = this.doc.eyes[ei];
    const skin = this.eyeSkin[ei];
    const tri = this.eyeTri[ei];
    const k = e.k;
    const cx = f.piv[ei * 3], cy = f.piv[ei * 3 + 1], cz = f.piv[ei * 3 + 2];
    let radius = 0; // nothing further from the pivot than the eye's own corners is inside it
    for (let i = 0; i < tri.length; i++) radius = Math.max(radius, Math.hypot(P[tri[i] * 3] - cx, P[tri[i] * 3 + 1] - cy, P[tri[i] * 3 + 2] - cz));
    const out = new Float32Array(skin.length);
    const far = radius + 0.003; // a vertex this far from the pivot is ≥ 3 mm outside: it cannot count, skip the search
    for (let s = 0; s < skin.length; s++) {
      if (fixed && fixed.still[s]) {
        out[s] = fixed.depth[s]; // it does not move relative to the eye on this line: same depth as at its start
        continue;
      }
      const px = P[skin[s] * 3], py = P[skin[s] * 3 + 1], pz = P[skin[s] * 3 + 2];
      const dist = Math.hypot(px - cx, py - cy, pz - cz);
      if (dist > far) {
        out[s] = (radius - dist) * 1000;
        continue;
      }
      let best = Infinity, depth = 0;
      for (let j = 0; j < k; j++) {
        const o = (s * k + j) * 3;
        const a = tri[o] * 3, b = tri[o + 1] * 3, c = tri[o + 2] * 3;
        const q = closestOnTriangle(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
        const d2 = (q[0] - px) ** 2 + (q[1] - py) ** 2 + (q[2] - pz) ** 2;
        if (d2 < best) {
          best = d2;
          const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
          const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz) || 1;
          depth = -((px - q[0]) * nx + (py - q[1]) * ny + (pz - q[2]) * nz) / nl; // inside = behind the normal
        }
      }
      out[s] = Math.min(depth, radius - dist) * 1000;
    }
    return out;
  }

  /** New crossings among the tested triangles, deepest in mm: mouth = tooth/tongue through skin, skin = skin through skin. */
  private crossings(P: Float32Array, allowed?: Map<number, number>, rest?: Map<number, number>): { mouth: number; skin: number; pairs: number[]; depths: number[] } {
    const c = this.doc.cross;
    const tri = this.crossTri;
    const T = tri.length / 3;
    // broad phase: every pair whose boxes overlap (closed, on all three axes) is tested once. The boxes go on a uniform
    // grid and a pair is taken in the one cell holding the corner where their overlap starts: the same pairs a sort and
    // sweep along x finds, without scanning every triangle that merely overlaps in x (most of them, in a face).
    const box = this.boxes.length === T * 6 ? this.boxes : (this.boxes = new Float32Array(T * 6));
    for (let t = 0; t < T; t++) {
      const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, d = tri[t * 3 + 2] * 3;
      for (let x = 0; x < 3; x++) {
        box[t * 6 + x] = Math.min(P[a + x], P[b + x], P[d + x]);
        box[t * 6 + 3 + x] = Math.max(P[a + x], P[b + x], P[d + x]);
      }
    }
    if (!this.cell) {
      // twice the median box size on the first face measured (any size gives the same pairs; this keeps cells small)
      const sizes = new Float32Array(T);
      for (let t = 0; t < T; t++) sizes[t] = Math.max(box[t * 6 + 3] - box[t * 6], box[t * 6 + 4] - box[t * 6 + 1], box[t * 6 + 5] - box[t * 6 + 2]);
      sizes.sort();
      this.cell = Math.max(2 * sizes[T >> 1], 1e-4);
    }
    const cell = this.cell;
    const at = (v: number) => Math.floor(v / cell);
    const key = (x: number, y: number, z: number) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
    const cells = this.cells.length === T * 6 ? this.cells : (this.cells = new Int32Array(T * 6));
    const grid = new Map<number, number[]>();
    for (let t = 0; t < T; t++) {
      for (let x = 0; x < 3; x++) {
        cells[t * 6 + x] = at(box[t * 6 + x]);
        cells[t * 6 + 3 + x] = at(box[t * 6 + 3 + x]);
      }
      for (let x = cells[t * 6]; x <= cells[t * 6 + 3]; x++)
        for (let y = cells[t * 6 + 1]; y <= cells[t * 6 + 4]; y++)
          for (let z = cells[t * 6 + 2]; z <= cells[t * 6 + 5]; z++) {
            const k = key(x, y, z);
            const list = grid.get(k);
            if (list) list.push(t);
            else grid.set(k, [t]);
          }
    }
    let mouth = 0, skin = 0;
    const pairs: number[] = [];
    const depths: number[] = [];
    for (const [k, list] of grid) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const u = list[j];
          if (box[u * 6] > box[t * 6 + 3] || box[t * 6] > box[u * 6 + 3]) continue;
          if (box[u * 6 + 1] > box[t * 6 + 4] || box[t * 6 + 1] > box[u * 6 + 4]) continue;
          if (box[u * 6 + 2] > box[t * 6 + 5] || box[t * 6 + 2] > box[u * 6 + 5]) continue;
          // only in the cell of the overlap's lowest corner (both boxes cover it): each pair once
          if (key(at(Math.max(box[t * 6], box[u * 6])), at(Math.max(box[t * 6 + 1], box[u * 6 + 1])), at(Math.max(box[t * 6 + 2], box[u * 6 + 2]))) !== k) continue;
          const lo = Math.min(t, u), hi = Math.max(t, u);
          // contact the checks allow: both near the average face's own contacts, or the same lid / lip / ear zone
          if ((c.contact[lo] && c.contact[hi]) || (c.zone[lo] >= 0 && c.zone[lo] === c.zone[hi])) continue;
          const isMouth = (c.inner[lo] && c.outer[hi]) || (c.inner[hi] && c.outer[lo]);
          const isSkin = !c.inner[lo] && !c.inner[hi];
          if (!isMouth && !isSkin) continue;
          if (sharesCorner(tri, lo, hi)) continue;
          if (!trianglesCross(P, tri, lo, hi, this.doc.thresholds.limiter_edge_tol ?? 0)) continue;
          pairs.push(lo * T + hi);
          const full = crossingDepth(P, tri, lo, hi);
          depths.push(full);
          if (rest && full <= (rest.get(lo * T + hi) ?? 0) + REST_NOISE_MM) continue; // no deeper than this face at rest
          // a crossing the average face also makes doing the same animation counts only by how much deeper it goes
          const depth = full - (allowed?.get(lo * T + hi) ?? 0);
          if (isMouth) mouth = Math.max(mouth, depth);
          else skin = Math.max(skin, depth);
        }
      }
    }
    return { mouth, skin, pairs, depths };
  }

  // --- faces as weights --------------------------------------------------------------------------------------------

  /** Is this resting face (store sliders + mixes, no animation) broken? False while the head has not loaded. */
  broken(store: LimitStore): boolean {
    if (!this.geom || !this.geom.positions((t) => store.userValue(t), this.cur.P, true, this.cur.piv)) return false;
    return this.test(this.cur).broken;
  }

  /**
   * How far slider `slider` may go each way from where it is ([lo, hi] in its own weight, within `ends`), every other
   * slider where it is. Cached until something else changes the face (invalidate()).
   */
  span(store: LimitStore, slider: string, ends: [number, number]): [number, number] {
    if (!this.geom) return ends;
    if (this.cache?.slider === slider) return this.cache.span;
    const g = this.geom;
    const x0 = store.base[slider] ?? 0;
    const combo = store.comboOf(slider);
    const pos = combo ? combo.pos : { [slider]: 1 };
    const neg = combo?.neg ? Object.fromEntries(Object.entries(combo.neg).map(([t, v]) => [t, -v])) : pos;
    const own = (t: string) => (x0 >= 0 ? pos[t] ?? 0 : neg[t] ?? 0) * x0;
    g.positions((t) => store.userValue(t) - own(t), this.line.P, true, this.line.piv);
    g.positions((t) => pos[t] ?? 0, this.up.P, false, this.up.piv);
    g.positions((t) => neg[t] ?? 0, this.down.P, false, this.down.piv);
    along(this.line, x0 >= 0 ? this.up : this.down, x0, this.cur);
    const fixed = this.stillEyes(this.cur, [this.up, this.down], Math.max(Math.abs(ends[0] - x0), Math.abs(ends[1] - x0)));
    const ok = (x: number) => {
      along(this.line, x >= 0 ? this.up : this.down, x, this.cur);
      return !this.test(this.cur, undefined, fixed).broken;
    };
    let span: [number, number] = ends;
    if (ok(x0)) {
      const limit = (end: number) => {
        if (ok(end)) return end;
        let good = x0, bad = end;
        for (let s = 0; s < LIMITS.steps; s++) {
          const mid = (good + bad) / 2;
          if (ok(mid)) good = mid;
          else bad = mid;
        }
        return good;
      };
      span = [limit(Math.min(ends[0], x0)), limit(Math.max(ends[1], x0))];
    } // a face that is already broken (a restored or linked face can be) is not trapped: no limits until it is fixed
    this.cache = { slider, span };
    return span;
  }

  /**
   * Eye vertices that the moves `dirs` (per unit, up to `reach` units) shift by under 0.05 mm relative to their eye keep
   * the depth they have in `at` (the checks work in 0.3 mm), so a nose or mouth slider does not re-search the eyes.
   */
  private stillEyes(at: Pose, dirs: Pose[], reach: number, atDepths?: Float32Array[]): { still: Uint8Array; depth: Float32Array }[] {
    return this.doc.eyes.map((_, ei) => {
      const skin = this.eyeSkin[ei];
      const still = new Uint8Array(skin.length);
      for (let i = 0; i < skin.length; i++) {
        let moving = 0;
        for (const d of dirs) {
          const v = skin[i] * 3;
          moving = Math.max(moving, Math.hypot(d.P[v] - d.piv[ei * 3], d.P[v + 1] - d.piv[ei * 3 + 1], d.P[v + 2] - d.piv[ei * 3 + 2]));
        }
        still[i] = moving * reach < 5e-5 ? 1 : 0;
      }
      return { still, depth: atDepths?.[ei] ?? this.eyeDepths(at, ei) };
    });
  }

  /** How far slider `slider` may go toward `end` from its value in `face` (others fixed). For Random face. */
  reach(face: LimitStore, slider: string, end: number): number {
    const saved = this.cache;
    this.cache = null;
    const x0 = face.base[slider] ?? 0;
    const [lo, hi] = this.span(face, slider, end < x0 ? [end, x0] : [x0, end]);
    this.cache = saved;
    return end < x0 ? lo : hi;
  }

  // --- animation caps ----------------------------------------------------------------------------------------------

  /**
   * How far each animation may go on this face (0..1): `channels` = {name: morph weights of that animation at full
   * strength}. Never less than it goes on the average face, where it is GNM's own motion.
   */
  caps(store: LimitStore, channels: Record<string, Weights>): Record<string, number> {
    const out: Record<string, number> = {};
    const g = this.geom;
    if (!g) return out;
    if (!this.avg) return out;
    g.positions((t) => store.userValue(t), this.line.P, true, this.line.piv);
    const thruAtRest = this.thru;
    // an animation counts only where it goes deeper than this face at rest, and there it is judged against the average
    // face doing it: a face that sits near (or a hair past) a limit at rest, e.g. deep-set eyes, would otherwise fail
    // before anything moved and freeze the animation (a mouth shape) at 0
    const atRest = this.restOf(thruAtRest);
    const rest = atRest.rest;
    for (const [name, anim] of Object.entries(channels)) {
      this.thru = thruAtRest; // (an earlier animation's merged candidates go)
      g.positions((t) => anim[t] ?? 0, this.up.P, false, this.up.piv);
      const reference = this.referenceFor(name, thruAtRest);
      this.thru = reference.thru;
      const ref: Ref = { ...reference.ref, rest };
      const fixed = this.stillEyes(this.line, [this.up], 1, atRest.eye); // a mouth shape does not re-search the eyes
      const ok = (s: number) => {
        along(this.line, this.up, s, this.cur);
        return !this.test(this.cur, ref, fixed).broken;
      };
      if (ok(1)) {
        out[name] = 1;
        if (name === "blink") for (const st of BLINK_STAGES) out[`blinkRetract${Math.round(st * 100)}`] = out.blinkRetract = 0;
        continue;
      }
      if (name === "blink") {
        // lids that would close into (or cut through) eyes sitting far forward: the eyeballs draw back as the lids close
        // (real eyes do), as little as works, solved at each stage of the blink (BLINK_STAGES; Head.tsx interpolates)
        const back = (r: number, s: number) => {
          along(this.line, this.up, s, this.cur);
          this.drawEyesBack(this.cur, r);
          return !this.test(this.cur, ref).broken;
        };
        const max = LIMITS.blinkRetractMm / 1000;
        const need = (s: number): number | null => {
          if (back(0, s)) return 0;
          if (!back(max, s)) return null;
          let lo = 0, hi = max;
          for (let k = 0; k < 8; k++) {
            const mid = (lo + hi) / 2;
            if (back(mid, s)) hi = mid;
            else lo = mid;
          }
          return hi;
        };
        let cap = 1;
        BLINK_STAGES.forEach((s, i) => {
          const r = cap === 1 ? need(s) : null;
          if (r === null && cap === 1) {
            // even drawn back fully the lids cannot get past this stage: the blink stops between here and the stage before
            let good = i ? BLINK_STAGES[i - 1] : 0, bad = s;
            for (let k = 0; k < 6; k++) {
              const mid = (good + bad) / 2;
              if (back(max, mid)) good = mid;
              else bad = mid;
            }
            cap = good;
          }
          out[`blinkRetract${Math.round(s * 100)}`] = (r ?? LIMITS.blinkRetractMm / 1000) * 1000;
        });
        out.blink = cap;
        out.blinkRetract = out.blinkRetract100;
        continue;
      }
      let good = 0, bad = 1;
      for (let s = 0; s < 8; s++) {
        const mid = (good + bad) / 2;
        if (ok(mid)) good = mid;
        else bad = mid;
      }
      out[name] = good;
    }
    this.thru = thruAtRest;
    return out;
  }

  /** caps(): this face at rest (this.line), measured once per face: kept for the last two faces (the emotion is judged
   *  on its own rest, every other animation on the plain one). */
  private restOf(thruAtRest: Limiter["thru"]): { rest: Depths; eye: Float32Array[] } {
    const hit = this.restMemo.find((m) => same(m.P, this.line.P) && same(m.piv, this.line.piv));
    if (hit) return hit;
    const restCross = this.crossings(this.line.P);
    const eye = this.doc.eyes.map((_, ei) => this.eyeDepths(this.line, ei));
    const rest: Depths = {
      eye: eye.map((d) => Array.from(d)),
      through: thruAtRest.map((th, ei) => Array.from(this.throughDepths(this.line, ei, th))),
      pairs: new Map(restCross.pairs.map((p, k) => [p, restCross.depths[k]])),
      lips: this.lipsThrough(this.line.P),
    };
    const m = { P: Float32Array.from(this.line.P), piv: Float32Array.from(this.line.piv), rest, eye };
    this.restMemo = [m, ...this.restMemo].slice(0, 2);
    return m;
  }

  /** caps(): the average face doing the animation in this.up, and its eye_through candidates. It never depends on the
   *  face, so it is kept per animation for as long as the animation (its positions) stays the same. */
  private referenceFor(name: string, thruAtRest: Limiter["thru"]): { ref: Omit<Ref, "rest">; thru: Limiter["thru"] } {
    const hit = this.refMemo.get(name);
    if (hit && same(hit.P, this.up.P) && same(hit.piv, this.up.piv)) return hit;
    along(this.avg!, this.up, 1, this.down); // the average face with this animation: what it may break anyway
    // eye_through: an animation moves lids across the eyes (a blink sweeps the upper lid down): each eye point also
    // gets the skin nearest its direction on the average face doing it
    const thru = thruAtRest.map((th, ei) => {
      const anim = pickSkinTriangles(this.down, ei, th.pts, th.tris, th.k);
      const cand = new Int32Array(th.pts.length * th.k * 2);
      for (let i = 0; i < th.pts.length; i++) {
        cand.set(th.cand.subarray(i * th.k, (i + 1) * th.k), i * th.k * 2);
        cand.set(anim.subarray(i * th.k, (i + 1) * th.k), i * th.k * 2 + th.k);
      }
      return { ...th, cand, k: th.k * 2 };
    });
    const ref = {
      eye: this.doc.eyes.map((e, ei) => maxOf(this.eyeDepths(this.down, ei), e.base)),
      through: thru.map((th, ei) => maxOf(this.throughDepths(this.down, ei, th), Array.from(th.base))),
      pairs: ((c) => new Map(c.pairs.map((p, k) => [p, c.depths[k]])))(this.crossings(this.down.P)),
      lips: this.lipsThrough(this.down.P),
    };
    const m = { P: Float32Array.from(this.up.P), piv: Float32Array.from(this.up.piv), ref, thru };
    this.refMemo.set(name, m);
    return m;
  }
}

/** Same numbers, element by element. */
function same(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const limiter = new Limiter();

// --- geometry helpers ---------------------------------------------------------------------------------------------

/**
 * For each tested skin vertex: the k eye triangles whose centres lie nearest its direction from the eye's pivot on the
 * average face (the pipeline's VLimits.build picks them the same way). Wide enough for the face to move.
 */
function pickEyeTriangles(avg: Pose, ei: number, skin: Int32Array, tris: Int32Array, k: number): Int32Array {
  const P = avg.P;
  const cx = avg.piv[ei * 3], cy = avg.piv[ei * 3 + 1], cz = avg.piv[ei * 3 + 2];
  const T = tris.length / 3;
  const dir = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 3; j++) {
      x += P[tris[t * 3 + j] * 3] / 3;
      y += P[tris[t * 3 + j] * 3 + 1] / 3;
      z += P[tris[t * 3 + j] * 3 + 2] / 3;
    }
    const l = Math.hypot(x - cx, y - cy, z - cz) || 1;
    dir.set([(x - cx) / l, (y - cy) / l, (z - cz) / l], t * 3);
  }
  const out = new Int32Array(skin.length * k * 3);
  const dots = new Float32Array(T);
  const order = new Int32Array(T);
  for (let s = 0; s < skin.length; s++) {
    const vx = P[skin[s] * 3] - cx, vy = P[skin[s] * 3 + 1] - cy, vz = P[skin[s] * 3 + 2] - cz;
    const l = Math.hypot(vx, vy, vz) || 1;
    for (let t = 0; t < T; t++) {
      dots[t] = (dir[t * 3] * vx + dir[t * 3 + 1] * vy + dir[t * 3 + 2] * vz) / l;
      order[t] = t;
    }
    order.sort((a, b) => dots[b] - dots[a]);
    for (let j = 0; j < k; j++) out.set(tris.subarray(order[j] * 3, order[j] * 3 + 3), (s * k + j) * 3);
  }
  return out;
}

function pose(n: number): Pose {
  return { P: new Float32Array(n), piv: new Float32Array(6) };
}

/** out = a + x · d (positions and pivots). */
function along(a: Pose, d: Pose, x: number, out: Pose): void {
  for (let i = 0; i < a.P.length; i++) out.P[i] = a.P[i] + x * d.P[i];
  for (let i = 0; i < 6; i++) out.piv[i] = a.piv[i] + x * d.piv[i];
}

function maxOf(a: Float32Array, b: number[]): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(a[i], b[i]);
  return out;
}

function sharesCorner(tri: Int32Array, t: number, u: number): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (tri[t * 3 + i] === tri[u * 3 + j]) return true;
  return false;
}

/** Does an edge of either triangle pass through the other (Möller–Trumbore), as in the pipeline's checks.py? */
function trianglesCross(P: Float32Array, tri: Int32Array, t: number, u: number, tol: number): boolean {
  return edgesThrough(P, tri, t, u, tol) || edgesThrough(P, tri, u, t, tol);
}

/** Does an edge of triangle s pass through triangle o? (No arrays per call: this runs for every candidate pair.) */
function edgesThrough(P: Float32Array, tri: Int32Array, s: number, o: number, tol: number): boolean {
  const a = tri[o * 3] * 3, b = tri[o * 3 + 1] * 3, c = tri[o * 3 + 2] * 3;
  const p0 = tri[s * 3] * 3, p1 = tri[s * 3 + 1] * 3, p2 = tri[s * 3 + 2] * 3;
  return segmentHits(P, p0, p1, a, b, c, tol) || segmentHits(P, p1, p2, a, b, c, tol) || segmentHits(P, p2, p0, a, b, c, tol);
}

/** How far a crossing pair really passes through (mm): each triangle's smaller poke through the other's plane, the
 *  smaller of the two (as checks.py crossing_depth): a graze is ~0. */
function crossingDepth(P: Float32Array, tri: Int32Array, t: number, u: number): number {
  const poke = (x: number, y: number) => {
    const a = tri[y * 3] * 3, b = tri[y * 3 + 1] * 3, c = tri[y * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    let pos = 0, neg = 0;
    for (let k = 0; k < 3; k++) {
      const p = tri[x * 3 + k] * 3;
      const d = ((P[p] - P[a]) * nx + (P[p + 1] - P[a + 1]) * ny + (P[p + 2] - P[a + 2]) * nz) / nl;
      pos = Math.max(pos, d);
      neg = Math.max(neg, -d);
    }
    return Math.min(pos, neg);
  };
  return Math.min(poke(t, u), poke(u, t)) * 1000;
}

/** Möller–Trumbore; `tol` also counts segments passing within that share of the triangle's border. */
function segmentHits(P: Float32Array, p: number, q: number, a: number, b: number, c: number, tol: number): boolean {
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const dx = P[q] - P[p], dy = P[q + 1] - P[p + 1], dz = P[q + 2] - P[p + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-18) return false;
  const inv = 1 / det;
  const sx = P[p] - P[a], sy = P[p + 1] - P[a + 1], sz = P[p + 2] - P[a + 2];
  const uu = (sx * hx + sy * hy + sz * hz) * inv;
  if (uu < -tol || uu > 1 + tol) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const vv = (dx * qx + dy * qy + dz * qz) * inv;
  if (vv < -tol || uu + vv > 1 + tol) return false;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt >= -tol && tt <= 1 + tol;
}

/**
 * For each visible eye point (slots `pts`), the k skin triangles (indices into `tris`, slot triplets) whose centres lie
 * nearest its direction from the eye's pivot on the average face (pipeline VLimits.build, eye_through).
 */
function pickSkinTriangles(avg: Pose, ei: number, pts: Int32Array, tris: Int32Array, k: number): Int32Array {
  const P = avg.P;
  const cx = avg.piv[ei * 3], cy = avg.piv[ei * 3 + 1], cz = avg.piv[ei * 3 + 2];
  const T = tris.length / 3;
  const dir = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    let x = 0, y = 0, z = 0;
    for (let q = 0; q < 3; q++) {
      const v = tris[t * 3 + q] * 3;
      x += P[v] / 3;
      y += P[v + 1] / 3;
      z += P[v + 2] / 3;
    }
    x -= cx;
    y -= cy;
    z -= cz;
    const l = Math.hypot(x, y, z) || 1;
    dir.set([x / l, y / l, z / l], t * 3);
  }
  const out = new Int32Array(pts.length * k);
  const best = new Float32Array(k), bestT = new Int32Array(k);
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i] * 3;
    const x = P[v] - cx, y = P[v + 1] - cy, z = P[v + 2] - cz;
    const l = Math.hypot(x, y, z) || 1;
    best.fill(-Infinity);
    for (let t = 0; t < T; t++) {
      const d = (dir[t * 3] * x + dir[t * 3 + 1] * y + dir[t * 3 + 2] * z) / l; // cosine: larger = nearer in direction
      if (d <= best[k - 1]) continue;
      let at = k - 1;
      while (at > 0 && d > best[at - 1]) {
        best[at] = best[at - 1];
        bestT[at] = bestT[at - 1];
        at--;
      }
      best[at] = d;
      bestT[at] = t;
    }
    out.set(bestT, i * k);
  }
  return out;
}

/** Distance along unit ray d (from the origin) to triangle abc, Infinity when it misses (Möller–Trumbore, both faces). */
function rayTriangle(dx: number, dy: number, dz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-14) return Infinity;
  const f = 1 / a;
  const sx = -ax, sy = -ay, sz = -az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return Infinity;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 0 ? t : Infinity;
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + v * abx, ay + v * aby, az + v * abz];
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + w * acx, ay + w * acy, az + w * acz];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
