/**
 * head.extra.glb: the semantic and emotion morph targets, fetched after the head is on screen so the first view
 * only waits for head.glb (the raw sliders). The pipeline writes both files from the same meshes and `uv run verify`
 * checks that every shared mesh has the SAME vertex order in both, so the extra targets are appended by index.
 *
 * Until it arrives the Identity/Emotion sliders already move (their values live in the morph store); the
 * shape appears the moment the targets are bound. The voice screenshot waits for it (extraReady).
 */
import { BufferAttribute, type BufferGeometry, Float32BufferAttribute, type Mesh, type Object3D } from "three";

import { manifest, MODELS_BASE } from "@/lib/data";
import { gltfLoader } from "@/lib/hair";
import { partDone, takePrefetched, whenRevealed } from "@/lib/headLoad";
import { morphs } from "@/lib/morphs/store";
import type { NormalRefresher } from "@/lib/morphs/normals";

/** Resolves when the extra targets are merged (or there are none, or loading failed: the head works without). Each mount
 *  (loadHeadExtra) makes its own; before the first, it waits. */
export let extraReady: Promise<void> = new Promise(() => {});

const partOf = (m: Object3D) => m.parent?.name || m.name;

/** How long the head has been on screen, fully revealed, before the extra targets are merged in (ms). */
const SETTLE_MS = 1500;

/** Resolves in the browser's next idle period (Safari has no requestIdleCallback: a short timeout instead). */
const idle = (timeout: number) =>
  new Promise<void>((resolve) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout }) : setTimeout(resolve, 50)));

/** Uniform scale of a mesh's own node: gltfpack puts the position dequantisation there. */
const nodeScale = (m: Object3D) => m.scale.x;

/** Delta attribute of `from` (its quantised units) → float32 in `to`'s units (same vertex order). */
function convert(attr: BufferAttribute, k: number): Float32BufferAttribute {
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i) * k;
    out[i * 3 + 1] = attr.getY(i) * k;
    out[i * 3 + 2] = attr.getZ(i) * k;
  }
  return new Float32BufferAttribute(out, 3);
}

/**
 * Load the extra targets and merge them into the head's meshes. `meshes` are head.glb's meshes (Head.tsx),
 * `refresher` recomputes their normals. Returns an abort function (unmount).
 */
export function loadHeadExtra(meshes: Mesh[], refresher: NormalRefresher): () => void {
  let aborted = false;
  let resolve: () => void = () => {};
  extraReady = new Promise((r) => (resolve = r));
  const file = manifest.extra?.file;
  if (!file) {
    resolve();
    return () => {};
  }
  // A face restored after a reload that uses these targets downloaded the file with the head (lib/faceSession.ts) and
  // holds the reveal for it: merge it at once, under the loader.
  const early = takePrefetched(MODELS_BASE + file);
  (async () => {
    // Otherwise only after the loader's reveal: downloading earlier would take bandwidth from the hair (on a phone the
    // reveal waits for it). The merge waits longer still (SETTLE_MS, then an idle moment): the first frame after it
    // recompiles the head's shaders and re-uploads its morph texture (~70 ms on a laptop, ~175 ms on a slow phone),
    // and that pause must not land on the tail of the reveal.
    if (!early) await whenRevealed(10000);
    if (aborted) return;
    const settled = early ? Promise.resolve() : new Promise((r) => setTimeout(r, SETTLE_MS));
    const [loader, buffer] = await Promise.all([
      gltfLoader(),
      early ??
        fetch(MODELS_BASE + file).then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.arrayBuffer();
        }),
    ]);
    if (aborted) return;
    const gltf = await loader.parseAsync(buffer, MODELS_BASE); // meshopt decode runs in workers (lib/hair.ts gltfLoader)
    await settled;
    if (!early) await idle(1000);
    if (aborted) return;
    const byPart = new Map(meshes.map((m) => [partOf(m), m]));
    gltf.scene.traverse((o) => {
      const extra = o as Mesh;
      if (!extra.isMesh) return;
      const base = byPart.get(partOf(extra));
      const names = Object.entries(extra.morphTargetDictionary ?? {}).sort((a, b) => a[1] - b[1]).map(([n]) => n);
      const attrs = (extra.geometry as BufferGeometry).morphAttributes.position ?? [];
      if (!base || !names.length) return;
      const geo = base.geometry as BufferGeometry;
      if (geo.attributes.position.count !== extra.geometry.attributes.position.count) {
        console.warn(`[head.extra] ${partOf(base)}: vertex counts differ; skipped`);
        return;
      }
      const k = nodeScale(extra) / nodeScale(base); // both files quantise the same positions; normally 1
      const list = (geo.morphAttributes.position ??= []);
      const dict = (base.morphTargetDictionary ??= {});
      const influences = (base.morphTargetInfluences ??= []);
      names.forEach((name, i) => {
        if (name in dict) return;
        dict[name] = list.length;
        list.push(convert(attrs[i] as BufferAttribute, k));
        influences.push(0);
      });
      morphs.unbind(base);
      morphs.bind(base); // applies the current values of the new targets
      refresher.remove(base);
      refresher.add(base);
      extra.geometry.dispose();
    });
    morphs.settleNow(); // normals now include the new targets
  })()
    .catch((e) => console.warn("[head.extra] not loaded:", e instanceof Error ? e.message : e))
    .finally(() => {
      resolve(); // this mount's promise: an aborted earlier load must not resolve a newer mount's
      partDone("extra"); // merged or failed: the reveal stops waiting either way (ignored when it never waited)
    });
  return () => {
    aborted = true;
  };
}
