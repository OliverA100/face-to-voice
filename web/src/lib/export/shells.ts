/**
 * Shell beards (lib/beardShells.ts) for character.glb. The app draws the beard's skin triangles again a few times, each
 * layer lifted off the skin by the vertex shader, with a tiling fur pattern deciding where a hair still reaches.
 * Here the same layers are built on the CPU, all in one mesh, skin side first: a viewer draws a mesh's triangles
 * in order, so the layers blend back to front for anyone looking at the face, whatever the viewer sorts by.
 *
 *   - position: the skin as drawn (morphs applied), lifted and combed down by the same rule as the shader
 *   - TEXCOORD_0: the skin's UV × SHELLS.furScale, on a 256 px fur tile (white, alpha = where a hair is) that repeats
 *     (glTF's default wrap), so the hairs land where the app draws them
 *   - COLOR_0: the layer's colour (root → tip, darker near the skin) and, in alpha, the share of hairs that reach the
 *     layer, thinned towards the tip and faded at the beard's edge (the shader's per-pixel alpha, per vertex)
 * Tweak here: SHELL_EXPORT.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  type InstancedMesh,
  type Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";

import { BANDS, fur, SHELLS, type ShellSource } from "@/lib/beardShells";

/** Tweak freely: how many layers the file gets (the app draws SHELLS.layers per quality tier). */
const SHELL_EXPORT = { layers: SHELLS.layers.high };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The beard's shell layers as one mesh in `m`'s space, or null when the mesh carries no shells data. */
export function shellMesh(shells: InstancedMesh, m: Matrix4): Mesh | null {
  const src = shells.userData.shells as ShellSource | undefined;
  const geometry = shells.geometry;
  const base = geometry.userData.baseIndexCount as number | undefined;
  if (!src || base === undefined || !geometry.index) return null;
  const index = geometry.index.array;
  const uv = geometry.attributes.uv;
  const normal = geometry.attributes.normal;

  // the beard's vertices, once each
  const local = new Map<number, number>();
  const verts: number[] = [];
  for (let t = base; t < index.length; t++) {
    if (!local.has(index[t])) {
      local.set(index[t], verts.length);
      verts.push(index[t]);
    }
  }
  const nv = verts.length;

  // per vertex: the mask (r = coverage, g = length; bilinear, as the shader's textureLod), the
  // drawn position, normal, comb
  const { width, height, data } = src.pixels;
  const texel = (x: number, y: number, c: number) => data[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4 + c] / 255;
  const mask = (u: number, v: number, c: number) => {
    const x = u * width - 0.5, y = v * height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return mix(mix(texel(x0, y0, c), texel(x0 + 1, y0, c), fx), mix(texel(x0, y0 + 1, c), texel(x0 + 1, y0 + 1, c), fx), fy);
  };
  const cover = new Float32Array(nv), length = new Float32Array(nv);
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), D = new Float32Array(nv * 3), UV = new Float32Array(nv * 2);
  const p = new Vector3(), n = new Vector3(), down = new Vector3();
  for (let i = 0; i < nv; i++) {
    const v = verts[i];
    const u = uv.getX(v), w = uv.getY(v);
    cover[i] = mask(u, w, 0);
    length[i] = src.lenLocal * mask(u, w, 1) * smoothstep(0.02, 0.5, cover[i]);
    shells.getVertexPosition(v, p).toArray(P, i * 3);
    n.fromBufferAttribute(normal, v).normalize().toArray(N, i * 3);
    down.set(0, -1, 0).addScaledVector(n, n.y); // gravity, along the skin
    if (down.length() > 1e-4) down.normalize();
    else down.set(0, 0, 0);
    down.toArray(D, i * 3);
    UV[i * 2] = u * SHELLS.furScale;
    UV[i * 2 + 1] = w * SHELLS.furScale;
  }

  // the share of the hairs (fur texels with any hair) that reach each band, for the shader's reach between bands
  const furData = fur().image.data as Uint8Array;
  const share = [0, 0, 0, 0];
  for (let i = 0; i < furData.length; i += 4) for (let c = 0; c < 4; c++) share[c] += furData[i + c];
  const f = share.map((s) => s / share[0]);
  const reach = (h: number) =>
    h < BANDS[0] ? f[0]
    : h < BANDS[1] ? mix(f[0], f[1], (h - BANDS[0]) / (BANDS[1] - BANDS[0]))
    : h < BANDS[2] ? mix(f[1], f[2], (h - BANDS[1]) / (BANDS[2] - BANDS[1]))
    : h < BANDS[3] ? mix(f[2], f[3], (h - BANDS[2]) / (BANDS[3] - BANDS[2]))
    : f[3] * (1 - smoothstep(0.9, 1, h));

  const K = SHELL_EXPORT.layers;
  const { gravity, density } = src.look;
  const rootC = new Color().copy(src.colours.root).convertSRGBToLinear();
  const tipC = new Color().copy(src.colours.tip).convertSRGBToLinear();
  const position = new Float32Array(K * nv * 3), normals = new Float32Array(K * nv * 3), uvs = new Float32Array(K * nv * 2);
  const colour = new Uint8Array(K * nv * 4);
  const triangles: number[] = [];
  const alpha = new Float32Array(nv);
  for (let k = 0; k < K; k++) {
    const layer = (k + 1) / K;
    const rgb = new Color().lerpColors(rootC, tipC, 0.35 + 0.6 * layer).multiplyScalar(mix(SHELLS.rootShade, 1, layer));
    const taper = 1 - SHELLS.taper * layer * layer; // the strands thin towards the tip
    for (let i = 0; i < nv; i++) {
      const o = (k * nv + i) * 3, len = length[i];
      for (let j = 0; j < 3; j++) position[o + j] = P[i * 3 + j] + (N[i * 3 + j] * (1 - 0.5 * gravity) + D[i * 3 + j] * gravity * layer) * len * layer;
      normals.set(N.subarray(i * 3, i * 3 + 3), o);
      uvs.set(UV.subarray(i * 2, i * 2 + 2), (k * nv + i) * 2);
      const h = layer / mix(0.6, 1, smoothstep(0.1, 0.7, cover[i]));
      alpha[i] = Math.min(1, reach(h) * taper * smoothstep(0.03, 0.5, cover[i]) * density);
      colour.set([rgb.r, rgb.g, rgb.b, alpha[i]].map((x) => Math.round(Math.min(1, x) * 255)), (k * nv + i) * 4);
    }
    // the layer's triangles, skipping those the shader would discard whole
    for (let t = base; t < index.length; t += 3) {
      const a = local.get(index[t])!, b = local.get(index[t + 1])!, c = local.get(index[t + 2])!;
      if (Math.max(alpha[a], alpha[b], alpha[c]) < 0.004) continue;
      triangles.push(k * nv + a, k * nv + b, k * nv + c);
    }
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(position, 3));
  out.setAttribute("normal", new BufferAttribute(normals, 3));
  out.setAttribute("uv", new BufferAttribute(uvs, 2));
  out.setAttribute("color", new BufferAttribute(colour, 4, true));
  out.setIndex(new BufferAttribute(K * nv > 65535 ? new Uint32Array(triangles) : new Uint16Array(triangles), 1));
  out.applyMatrix4(m);

  const material = new MeshPhysicalMaterial({
    name: "beard_shells", map: furMap(), vertexColors: true, transparent: true, depthWrite: false,
    roughness: SHELLS.roughness, metalness: 0, specularIntensity: SHELLS.specular,
  });
  const mesh = new Mesh(out, material);
  mesh.name = "beard_shells";
  return mesh;
}

/** The fur tile as a PNG: white, alpha 1 where a hair is (the lowest band: every hair reaches it). */
function furMap(): CanvasTexture {
  const tex = fur();
  const { width, height } = tex.image;
  const src = tex.image.data as Uint8Array;
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < width * height; i++) px[i * 4 + 3] = src[i * 4];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(px, width, height), 0, 0);
  const map = new CanvasTexture(canvas);
  map.flipY = false;
  map.wrapS = map.wrapT = RepeatWrapping;
  map.colorSpace = SRGBColorSpace;
  map.name = "beard_fur";
  return map;
}
