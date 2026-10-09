/**
 * The live normal refreshes of a slow device, off the main thread (lib/morphs/normalsCompute.ts; lib/morphs/normals.ts
 * asks). It keeps each mesh's rest shape and the deltas it has been sent; a refresh names the non-zero targets and weights.
 */
import { computeShape, type ShapeMesh } from "./normalsCompute";

export type ToNormalsWorker =
  | { type: "mesh"; id: number; mesh: ShapeMesh }
  | { type: "delta"; id: number; target: string; data: Float32Array }
  | { type: "refresh"; req: number; jobs: { id: number; active: [string, number][] }[] }
  | { type: "drop"; id: number };
export type FromNormalsWorker = { req: number; out: { id: number; positions: Float32Array; normals: Float32Array }[] } | { req: number; error: string };

const meshes = new Map<number, { mesh: ShapeMesh; deltas: Map<string, Float32Array> }>();

self.onmessage = (e: MessageEvent<ToNormalsWorker>) => {
  const m = e.data;
  if (m.type === "mesh") meshes.set(m.id, { mesh: m.mesh, deltas: new Map() });
  else if (m.type === "delta") meshes.get(m.id)?.deltas.set(m.target, m.data);
  else if (m.type === "drop") meshes.delete(m.id);
  else {
    try {
      const out = m.jobs.map(({ id, active }) => {
        const entry = meshes.get(id);
        if (!entry) throw new Error(`mesh ${id} not sent`);
        const positions = new Float32Array(entry.mesh.base.length);
        const normals = new Float32Array(entry.mesh.base.length);
        computeShape(entry.mesh, active.map(([target, w]) => ({ w, data: entry.deltas.get(target)! })), positions, normals);
        return { id, positions, normals };
      });
      (self as unknown as Worker).postMessage({ req: m.req, out } satisfies FromNormalsWorker, out.flatMap((o) => [o.positions.buffer, o.normals.buffer]));
    } catch (err) {
      (self as unknown as Worker).postMessage({ req: m.req, error: err instanceof Error ? err.message : String(err) } satisfies FromNormalsWorker);
    }
  }
};
