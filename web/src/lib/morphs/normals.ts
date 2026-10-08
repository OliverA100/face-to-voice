/**
 * Morph targets in head.glb carry positions only (normals would double the GPU memory and the
 * file size). Big identity changes would then shade wrongly, so whenever the held shape changes we
 * recompute smooth vertex normals on the CPU from base + Σ weight·delta and upload them.
 * ~1-3 ms for the whole head; Head.tsx runs it live while the shape moves (within its LIVE_SETTLE
 * frame budget) and once more when it settles.
 */
import { BufferAttribute, Float32BufferAttribute, type Mesh } from "three";

type Entry = {
  mesh: Mesh;
  index: Uint16Array | Uint32Array;
  base: Float32Array;
  /** Delta arrays are converted lazily on the first refresh that needs them (keeps the first frame cheap). */
  deltas: { target: string; attr: BufferAttribute; data: Float32Array | null }[];
  normal: Float32BufferAttribute;
  scratch: Float32Array;
  /** UV seams: each vertex → the first vertex at the same place (the copies must share one normal), or null. */
  weld: Int32Array | null;
  dirty: boolean; // normals currently differ from the rest pose
};

/**
 * head.glb splits vertices along UV seams: the copies share position, deltas and rest normal but not triangles, so
 * normals computed per copy would show a crease along every seam. Map each copy to the first one. Same position AND
 * same rest normal, so surfaces that merely touch (upper and lower teeth) stay apart.
 */
function seamWeld(base: Float32Array, normal: Float32Array): Int32Array | null {
  const first = new Map<string, number>();
  const weld = new Int32Array(base.length / 3);
  let twins = 0;
  for (let i = 0; i < weld.length; i++) {
    const j = i * 3;
    const key = `${base[j]},${base[j + 1]},${base[j + 2]}|${normal[j].toFixed(2)},${normal[j + 1].toFixed(2)},${normal[j + 2].toFixed(2)}`;
    const k = first.get(key);
    if (k === undefined) {
      first.set(key, i);
      weld[i] = i;
    } else {
      weld[i] = k;
      twins++;
    }
  }
  return twins ? weld : null;
}

/** Read an attribute into a float array (works for the quantised int attributes gltfpack writes). */
function toFloat(attr: BufferAttribute): Float32Array {
  // Fast path only for plain, tightly packed arrays. gltfpack pads vertex streams, so three.js
  // often gives us interleaved attributes whose backing array is longer than count × 3.
  const packed = !(attr as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && attr.array.length === attr.count * 3;
  if (!attr.normalized && attr.itemSize === 3 && packed) return Float32Array.from(attr.array as ArrayLike<number>);
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return out;
}

export class NormalRefresher {
  private entries: Entry[] = [];
  private listeners = new Set<(mesh: Mesh, positions: Float32Array) => void>();

  /** Called after a mesh's shape is recomputed (positions in the mesh's own, quantised space; the rest pose too). */
  onRefresh(fn: (mesh: Mesh, positions: Float32Array) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Keep `acc` equal to the current morph offset (Σ weight · delta, the mesh's own space) of a few vertices, live
   * (blinks, speech and expressions included): only targets whose weight changed since the last call (kept in `last`)
   * are added, so a blink costs four targets, not a hundred. Lashes and brows call it every frame.
   */
  accumulateOffsets(mesh: Mesh, ids: Int32Array, weight: (target: string) => number, last: Map<string, number>, acc: Float32Array): boolean {
    const e = this.entries.find((x) => x.mesh === mesh);
    if (!e) return false;
    for (const d of e.deltas) {
      const w = weight(d.target);
      const dw = w - (last.get(d.target) ?? 0);
      if (dw === 0) continue;
      last.set(d.target, w);
      const data = (d.data ??= toFloat(d.attr));
      for (let i = 0; i < ids.length; i++) {
        const v = ids[i] * 3;
        acc[i * 3] += dw * data[v];
        acc[i * 3 + 1] += dw * data[v + 1];
        acc[i * 3 + 2] += dw * data[v + 2];
      }
    }
    return true;
  }

  /**
   * Positions of vertices `ids` (the mesh's own space) for any weights: rest + Σ weight · delta into `out` (3 floats
   * each), or with `rest` false only Σ weight · delta (a direction: how they move per unit of a slider). Used by the
   * limiter (lib/morphs/limits.ts) for the few thousand vertices that can break. False if the mesh is not registered.
   */
  sample(mesh: Mesh, ids: Int32Array, weight: (target: string) => number, out: Float32Array, rest = true): boolean {
    const e = this.entries.find((x) => x.mesh === mesh);
    if (!e) return false;
    for (let i = 0; i < ids.length; i++) {
      const v = ids[i] * 3;
      out[i * 3] = rest ? e.base[v] : 0;
      out[i * 3 + 1] = rest ? e.base[v + 1] : 0;
      out[i * 3 + 2] = rest ? e.base[v + 2] : 0;
    }
    for (const d of e.deltas) {
      const w = weight(d.target);
      if (!w) continue;
      const data = (d.data ??= toFloat(d.attr));
      for (let i = 0; i < ids.length; i++) {
        const v = ids[i] * 3;
        out[i * 3] += w * data[v];
        out[i * 3 + 1] += w * data[v + 1];
        out[i * 3 + 2] += w * data[v + 2];
      }
    }
    return true;
  }

  /** The rest positions and the latest shaped ones of a registered mesh (both in its own space), or null. */
  shapeOf(mesh: Mesh): { rest: Float32Array; current: Float32Array } | null {
    const e = this.entries.find((x) => x.mesh === mesh);
    return e ? { rest: e.base, current: e.dirty ? e.scratch : e.base } : null;
  }

  add(mesh: Mesh): void {
    const g = mesh.geometry;
    const pos = g.attributes.position as BufferAttribute;
    const dict = mesh.morphTargetDictionary ?? {};
    const morphs = g.morphAttributes.position ?? [];
    const deltas = Object.entries(dict).map(([target, i]) => ({ target, attr: morphs[i] as BufferAttribute, data: null }));
    // Replace the 8-bit normals from gltfpack with a float attribute we can rewrite.
    const normal = new Float32BufferAttribute(toFloat(g.attributes.normal as BufferAttribute), 3);
    g.setAttribute("normal", normal);
    const base = toFloat(pos);
    this.entries.push({
      mesh,
      // only the mesh's own triangles: beard shells append copies of some after them (lib/beardShells.ts)
      index: (g.index!.array as Uint16Array | Uint32Array).subarray(0, (g.userData.baseIndexCount as number | undefined) ?? g.index!.count),
      base,
      weld: seamWeld(base, normal.array as Float32Array),
      deltas,
      normal,
      scratch: new Float32Array(pos.count * 3),
      dirty: false,
    });
  }

  clear(): void {
    this.entries = [];
  }

  /** Forget one mesh (its morph targets changed: head.extra.glb appends more; add() it again). */
  remove(mesh: Mesh): void {
    this.entries = this.entries.filter((e) => e.mesh !== mesh);
  }

  /**
   * Convert up to one delta array now, for a target `wanted` accepts; false once there is nothing left. Head.tsx runs it in
   * idle time after the head is on screen, so the first Random face doesn't convert ~60 targets in one frame (~40 ms).
   */
  warmStep(wanted: (target: string) => boolean): boolean {
    for (const e of this.entries) {
      const d = e.deltas.find((x) => x.data === null && wanted(x.target));
      if (d) {
        d.data = toFloat(d.attr);
        return true;
      }
    }
    return false;
  }

  /** `weight(target)` returns the effective influence currently applied to that target. */
  refresh(weight: (target: string) => number): void {
    for (const e of this.entries) {
      const active = e.deltas.filter(({ target }) => weight(target) !== 0);
      if (active.length === 0 && !e.dirty) continue; // at rest the file's normals are already right
      e.dirty = active.length > 0;
      const p = e.scratch;
      p.set(e.base);
      for (const d of active) {
        const w = weight(d.target);
        const data = (d.data ??= toFloat(d.attr));
        for (let i = 0; i < p.length; i++) p[i] += w * data[i];
      }
      const n = e.normal.array as Float32Array;
      n.fill(0);
      const idx = e.index;
      const weld = e.weld;
      for (let t = 0; t < idx.length; t += 3) {
        const a = (weld ? weld[idx[t]] : idx[t]) * 3, b = (weld ? weld[idx[t + 1]] : idx[t + 1]) * 3, c = (weld ? weld[idx[t + 2]] : idx[t + 2]) * 3;
        const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
        const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
        n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
        n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
      }
      for (let i = 0; i < n.length; i += 3) {
        const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
      }
      if (weld) {
        for (let i = 0; i < weld.length; i++) {
          const k = weld[i];
          if (k !== i) {
            n[i * 3] = n[k * 3]; n[i * 3 + 1] = n[k * 3 + 1]; n[i * 3 + 2] = n[k * 3 + 2];
          }
        }
      }
      e.normal.needsUpdate = true;
      for (const fn of this.listeners) fn(e.mesh, p);
    }
  }
}
