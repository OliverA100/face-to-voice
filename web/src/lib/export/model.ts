/**
 * character.glb: the character as a static 3D model, held still as in the portrait (shape, expression and pose baked
 * in; no blink, speech or idle sway). Built in the browser from what the tab already has:
 *
 *   - geometry: every head part and the glasses with their morph targets applied on the CPU (Mesh.getVertexPosition,
 *     the same sum the GPU draws) and the node transforms (dequantisation, eye pivots, head pose) baked in. Metres,
 *     Y up, the same origin as head.glb. The normals are the ones the app shades with (NormalRefresher's).
 *   - colour: each part's own shader is drawn once in its UV space and its colour (before any lighting) read back: the
 *     skin keeps its tone, redness, lips, eye shadow, age and stubble; the eyes their iris, pupil and veins; the inside
 *     of the mouth its shade. JPEG textures, seams padded so a filtered lookup never reaches the background.
 *   - the cornea becomes a faint clear shell (in the app it is black and additive: reflections only).
 *
 * Strand pieces (hair, brows, lashes, strand beards) become ribbons, the child strands included (lib/export/strands.ts);
 * shell beards their fur layers, built on the CPU (lib/export/shells.ts).
 * Tweak here: MODEL.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  type InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type WebGLRenderer,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import { headRig } from "@/components/scene/Head";
import { sceneRig } from "@/lib/sceneRig";
import { addonRig } from "@/lib/addons";
import { characterSettled } from "@/lib/character";
import { extraReady } from "@/lib/headExtra";

import { holdStill } from "./portrait";
import { shellMesh } from "./shells";
import { strandMeshes, type StrandMode } from "./strands";

/** Tweak freely: texture sizes (px, square) per part, how far seams are padded, JPEG quality. */
export const MODEL = {
  size: { skin: 1024, sclera: 512, iris: 512, pupil: 64, mouth: 256, teeth: 256, gums: 256, tongue: 256 } as Record<string, number>,
  pad: 6, // px the colour is grown past each UV island's edge
  jpeg: 0.9,
  cornea: { opacity: 0.08, roughness: 0.05 },
};

/** Inside the mouth: the colour × its shade behind the lips (lib/mouthShade.ts sets mouthT, then lights the colour). */
const MOUTH_SHADE = "diffuseColor.rgb * mix(uMouthDeep, vec3(uMouthLight), mouthT)";
const SHADE: Record<string, string> = { mouth: MOUTH_SHADE, teeth: MOUTH_SHADE, gums: MOUTH_SHADE, tongue: MOUTH_SHADE };

/**
 * The GLB's bytes. Waits for a Random character / Reset to land and for the semantic and emotion targets. `strands`: the
 * hair, brows, lashes and strand beards as guide ribbons, with their child strands too, or left out.
 */
export async function buildModel({ strands = "children" }: { strands?: StrandMode | "none" } = {}): Promise<Uint8Array> {
  await characterSettled();
  await extraReady;
  const { gl, camera, scene } = sceneRig;
  const sway = headRig.sway;
  if (!gl || !camera || !scene || !sway) throw new Error("scene not ready");

  const root = new Group();
  root.name = "character";
  const restore = holdStill();
  try {
    sway.updateWorldMatrix(true, true);
    const toBust = new Matrix4().copy(sway.parent?.matrixWorld ?? new Matrix4()).invert(); // the bust's own space: the head pose stays in
    const glasses = addonRig.meshes.glasses;
    sway.traverseVisible((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const matrix = new Matrix4().multiplyMatrices(toBust, mesh.matrixWorld);
      if ((mesh as InstancedMesh).isInstancedMesh) {
        const shells = shellMesh(mesh as InstancedMesh, matrix); // a shell beard (the only instanced mesh on the head)
        if (shells) root.add(shells);
        return;
      }
      if (mesh.userData.groom) {
        if (strands === "none") return;
        mesh.onBeforeRender(gl, scene, camera, mesh.geometry, mesh.material as Material, null as unknown as Group); // roots onto the posed skin, as a frame would
        for (const piece of strandMeshes(mesh, matrix, strands, mesh.parent?.name || "hair")) root.add(piece);
        return;
      }
      const part = (mesh.parent?.name || mesh.name).replace(/_[LR]$/, "");
      const side = /_([LR])$/.exec(mesh.parent?.name ?? "")?.[1] ?? "";
      let material: Material | null = null;
      if (part === "cornea") material = cornea();
      else if (MODEL.size[part]) material = baked(gl, camera, mesh, part, side);
      else if (glasses && isInside(mesh, glasses)) material = glassesMaterial(materialOf(mesh));
      if (!material) return;
      const out = new Mesh(bakeGeometry(mesh, matrix), material);
      out.name = (mesh.parent?.name || mesh.name || part) + (material.name === "glasses_lens" ? "_lens" : "");
      root.add(out);
    });
  } finally {
    restore();
  }

  try {
    const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
    return new Uint8Array(glb);
  } finally {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const m = mesh.material as MeshStandardMaterial;
      if (!m.userData.shared) m.map?.dispose(); // the glasses' maps stay the app's
      m.dispose();
    });
  }
}

/** A mesh's material; a shell beard makes the skin's a one-item list (lib/beardShells.ts). */
const materialOf = (mesh: Mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshPhysicalMaterial;

const isInside = (o: Object3D, node: Object3D) => {
  for (let p: Object3D | null = o; p; p = p.parent) if (p === node) return true;
  return false;
};

/** Positions as drawn (morphs applied), normals as shaded, UVs and the mesh's own triangles, all in `m`'s space. */
function bakeGeometry(mesh: Mesh, m: Matrix4): BufferGeometry {
  const src = mesh.geometry;
  const n = src.attributes.position.count;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const v = new Vector3();
  const normalMatrix = new Matrix3().getNormalMatrix(m);
  const srcNormal = src.attributes.normal as BufferAttribute | undefined;
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v).applyMatrix4(m).toArray(position, i * 3);
    if (srcNormal) v.fromBufferAttribute(srcNormal, i).applyMatrix3(normalMatrix).normalize().toArray(normal, i * 3);
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(position, 3));
  if (srcNormal) out.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  const uv = src.attributes.uv as BufferAttribute | undefined;
  if (uv) {
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = uv.getX(i);
      data[i * 2 + 1] = uv.getY(i);
    }
    out.setAttribute("uv", new Float32BufferAttribute(data, 2));
  }
  if (src.index) {
    // only the mesh's own triangles: a shell beard appends copies of some after them (lib/beardShells.ts)
    const count = (src.userData.baseIndexCount as number | undefined) ?? src.index.count;
    out.setIndex(new BufferAttribute(src.index.array.slice(0, count), 1));
  }
  if (!srcNormal) out.computeVertexNormals();
  return out;
}

/** A head part with its colour baked from its own shader. */
function baked(gl: WebGLRenderer, camera: Camera, mesh: Mesh, part: string, side: string): MeshStandardMaterial | null {
  const src = materialOf(mesh);
  if (!mesh.geometry.attributes.uv) return null;
  const map = new CanvasTexture(bakeColour(gl, camera, mesh, MODEL.size[part], SHADE[part]));
  map.flipY = false; // as glTF has it: the image's top row is v = 0, the row the bake wrote first
  map.colorSpace = SRGBColorSpace;
  map.userData.mimeType = "image/jpeg";
  map.name = `${part}${side ? "_" + side : ""}`;
  return new MeshStandardMaterial({ name: map.name, map, roughness: src.roughness, metalness: 0 });
}

/**
 * Draw `mesh` with its own material into its UV layout and read the colour back: the vertex shader puts each vertex
 * at its UV, the fragment shader ends by writing the surface colour (`colour`, default diffuseColor) in sRGB instead of
 * the lit result. Everything the shader computes from the shape (age, mouth depth, lid shadow) still sees the posed
 * mesh: the copy shares its geometry, morph weights and world matrix.
 */
function bakeColour(gl: WebGLRenderer, camera: Camera, mesh: Mesh, size: number, colour = "diffuseColor.rgb"): HTMLCanvasElement {
  const src = materialOf(mesh);
  const material = src.clone();
  material.defines = { ...src.defines }; // copy() resets them to STANDARD/PHYSICAL: the iris map and stubble live there
  Object.assign(material, { side: DoubleSide, transparent: false, blending: NormalBlending, depthTest: false, depthWrite: false });
  material.onBeforeCompile = (shader, renderer) => {
    src.onBeforeCompile(shader, renderer);
    shader.vertexShader = beforeEnd(shader.vertexShader, "gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);");
    shader.fragmentShader = beforeEnd(shader.fragmentShader, `gl_FragColor = vec4(sRGBTransferOETF(vec4(${colour}, 1.0)).rgb, 1.0);`);
  };
  material.customProgramCacheKey = () => `${src.customProgramCacheKey()}|uv-bake|${colour}`;

  const copy = new Mesh(mesh.geometry, material);
  copy.morphTargetInfluences = mesh.morphTargetInfluences?.slice();
  copy.morphTargetDictionary = mesh.morphTargetDictionary;
  copy.frustumCulled = false;
  copy.matrixAutoUpdate = false;
  copy.matrixWorld.copy(mesh.matrixWorld);
  const scene = new Scene();
  scene.matrixWorldAutoUpdate = false;
  scene.add(copy);

  const target = new WebGLRenderTarget(size, size);
  const saved = { target: gl.getRenderTarget(), colour: gl.getClearColor(new Color()), alpha: gl.getClearAlpha() };
  const pixels = new Uint8Array(size * size * 4);
  try {
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, camera);
    gl.readRenderTargetPixels(target, 0, 0, size, size, pixels); // row 0 = v 0
  } finally {
    gl.setRenderTarget(saved.target);
    gl.setClearColor(saved.colour, saved.alpha);
    target.dispose();
    material.dispose();
  }
  pad(pixels, size, MODEL.pad);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), size, size), 0, 0);
  return canvas;
}

/** Insert `line` before the closing brace of main() (the last one in the shader). */
function beforeEnd(shader: string, line: string): string {
  const at = shader.lastIndexOf("}");
  return shader.slice(0, at) + line + "\n" + shader.slice(at);
}

/**
 * Grow each UV island's colour `passes` px into the empty texels round it (each takes the average of its painted
 * neighbours), so mipmaps and filtering at a seam never pull in the background. Then everything is opaque.
 */
export function pad(px: Uint8Array, size: number, passes: number): void {
  let edge: number[] = [];
  for (let i = 0; i < size * size; i++) if (px[i * 4 + 3] === 0) edge.push(i);
  for (let p = 0; p < passes && edge.length; p++) {
    const filled: [number, number, number, number][] = [];
    const left: number[] = [];
    for (const i of edge) {
      const x = i % size, y = (i - x) / size;
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size || (dx === 0 && dy === 0)) continue;
          const j = (yy * size + xx) * 4;
          if (px[j + 3] === 0) continue;
          r += px[j];
          g += px[j + 1];
          b += px[j + 2];
          k++;
        }
      }
      if (k) filled.push([i, r / k, g / k, b / k]);
      else left.push(i);
    }
    for (const [i, r, g, b] of filled) px.set([r, g, b, 255], i * 4); // after the pass: one ring per pass
    edge = left;
  }
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
}

/** The clear eye shell: a faint glossy film (the app draws it as reflections only). */
function cornea(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({ name: "cornea", color: 0xffffff, transparent: true, opacity: MODEL.cornea.opacity, roughness: MODEL.cornea.roughness, metalness: 0, depthWrite: false });
}

/** The frame keeps its painted maps; the lens its tint and opacity (the app adds glare in its shader). */
function glassesMaterial(src: MeshPhysicalMaterial): Material {
  if (src.name !== "glasses_lens") {
    const m = new MeshPhysicalMaterial({
      name: src.name, map: src.map, metalnessMap: src.metalnessMap, roughnessMap: src.roughnessMap, metalness: src.metalness,
      roughness: src.roughness, clearcoat: src.clearcoat, clearcoatRoughness: src.clearcoatRoughness,
    });
    m.userData.shared = true; // its maps are the app's: not disposed with the export
    return m;
  }
  return new MeshStandardMaterial({ name: src.name, color: src.color, opacity: src.opacity, transparent: true, roughness: src.roughness, metalness: src.metalness, side: DoubleSide, depthWrite: false });
}
