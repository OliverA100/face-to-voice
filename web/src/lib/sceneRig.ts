/**
 * The live renderer, scene and camera (set by components/scene/Capture.tsx), for code outside the canvas: the voice's
 * screenshot and shader warm-ups. A plain module, so importing it doesn't pull React Three Fiber into the page's first
 * JavaScript (the canvas is a lazy chunk).
 * The drawing buffer is not preserved between frames (cheaper), so captureFace() renders one frame
 * explicitly and copies it synchronously in the same task.
 */
import type { Camera, Mesh, MeshStandardMaterial, Object3D, Scene, Texture, WebGLRenderer } from "three";

export const sceneRig = { gl: null as WebGLRenderer | null, scene: null as Scene | null, camera: null as Camera | null };

/** JPEG data URL of the current view, long edge `size` px (Claude bills ~ (w/28)·(h/28) tokens). */
export function captureFace(size = 768, quality = 0.85): string {
  const { gl, scene, camera } = sceneRig;
  if (!gl || !scene || !camera) throw new Error("scene not ready");
  // The picture shows the character as the visitor styled it (hair and every add-on included).
  gl.render(scene, camera);
  const src = gl.domElement;
  const scale = size / Math.max(src.width, src.height);
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * scale);
  out.height = Math.round(src.height * scale);
  out.getContext("2d")!.drawImage(src, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", quality);
}

/**
 * Compile the shaders `nodes` need before they are first drawn (Random character: the arriving hair and add-ons, while
 * the old look is still showing). three otherwise compiles on first draw, and a new hair style or add-on needs its own
 * programs (their morph target counts differ), which would stall the fade's first
 * frame by 30–70 ms. compileAsync uses KHR_parallel_shader_compile, so the main thread keeps running meanwhile.
 */
export async function precompile(nodes: readonly Object3D[]): Promise<void> {
  const { gl, scene, camera } = sceneRig;
  if (!gl || !scene || !camera || !nodes.length) return;
  await Promise.all(nodes.map((node) => gl.compileAsync(node, camera, scene)));
  // Upload their textures now too, one per frame: otherwise the first draw uploads them all and the fade's first frame
  // waits for the GPU.
  const textures = new Set<Texture>();
  for (const node of nodes)
    node.traverse((o) => {
      const material = (o as Mesh).material as MeshStandardMaterial | undefined;
      for (const t of [material?.map, material?.normalMap, material?.aoMap]) if (t) textures.add(t);
    });
  for (const t of textures) {
    gl.initTexture(t);
    await new Promise((r) => requestAnimationFrame(r));
  }
}
