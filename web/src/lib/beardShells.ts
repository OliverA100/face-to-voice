/**
 * Short beards drawn as shells (facial hair styles of kind "shells", pipeline stubble.py): the beard area of the skin,
 * drawn again a few times, each layer lifted a little further off the skin and combed down along it. A tileable fur
 * pattern decides, per layer, where a hair still reaches that high, so the layers stack into short hairs.
 *
 * Why it follows the mouth: the shells are the skin's own triangles. Their copies are appended to the skin geometry's
 * index (a second geometry group the skin itself does not draw), and an InstancedMesh draws that group once per layer
 * (one draw call), sharing the skin mesh's morph weights. So every morph (identity, speech, emotions, the targets
 * that load later) moves the beard exactly as it moves the skin, and the refreshed normals are shared too.
 *
 * Masks: PNG in the skin's UV layout (R = coverage, G = length), read once on the CPU to pick the beard triangles.
 * Tweak here: SHELLS.
 */
import {
  BufferAttribute,
  type BufferGeometry,
  type Color,
  DataTexture,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  RepeatWrapping,
  RGBAFormat,
  Texture,
  UnsignedByteType,
  Vector3,
} from "three";

import { headSpaceMatrix } from "@/lib/age";
import { onTier, quality } from "@/lib/quality";
import { installMorph } from "@/lib/morphShader";

/** Group 0 of the shells (the skin's own triangles) draws nothing. A real material, not an empty slot: three's draw
 * skips an empty slot, but its compile (Head.tsx: the morph look, compiled in the background) reads every slot and
 * throws on an empty one. */
const NO_DRAW = new MeshBasicMaterial({ visible: false });

export const SHELLS = {
  layers: { low: 6, medium: 10, high: 16 }, // per quality tier (lib/quality.ts)
  furScale: 50, // fur tiles across the skin's UV square (about 8 mm per tile on the face)
  hairs: 1100, // hairs per fur tile
  hairRadiusPx: [1.3, 2.1], // in the 256 px tile
  taper: 0.7, // hairs thin towards the tip
  rootShade: 0.6, // brightness at the skin (the hairs shade each other)
  roughness: 0.8,
  specular: 0.25, // share of the usual dielectric reflection (full = a grey sheen over dark hair)
};

let furTexture: DataTexture | null = null;

/** The tileable fur pattern (made once). Each channel is 1 where a hair reaches at least a given height (R 0.2,
 *  G 0.45, B 0.7, A 0.9 of full length), 0 elsewhere. Mipmapping turns that into the share of hair reaching each
 *  height, so far away a layer draws as partial coverage (alpha-to-coverage) instead of collapsing into a solid
 *  sheet, and close up the hairs are crisp discs. */
const BANDS = [0.2, 0.45, 0.7, 0.9];
function fur(): DataTexture {
  if (furTexture) return furTexture;
  const n = 256;
  const tall = new Float32Array(n * n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const [r0, r1] = SHELLS.hairRadiusPx;
  for (let k = 0; k < SHELLS.hairs; k++) {
    const cx = rnd() * n, cy = rnd() * n, r = r0 + rnd() * (r1 - r0), h = 0.35 + 0.65 * rnd();
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
        const i = (((y % n) + n) % n) * n + (((x % n) + n) % n);
        tall[i] = Math.max(tall[i], h);
      }
    }
  }
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = tall[i] >= BANDS[c] ? 255 : 0;
  furTexture = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  furTexture.wrapS = furTexture.wrapT = RepeatWrapping;
  furTexture.magFilter = LinearFilter;
  furTexture.minFilter = LinearMipmapLinearFilter;
  furTexture.generateMipmaps = true;
  furTexture.needsUpdate = true;
  return furTexture;
}

type ShellLook = { lengthMm: number; gravity: number; density: number };

/** Fetch a shell style's mask: the GPU texture plus its pixels for picking the beard triangles. */
export async function loadShellMask(url: string, signal?: AbortSignal): Promise<{ texture: Texture; pixels: ImageData }> {
  const blob = await (await fetch(url, { signal })).blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const texture = new Texture(bitmap);
  texture.flipY = false; // rows run with v, like the KTX2 skin maps
  texture.needsUpdate = true;
  return { texture, pixels };
}

let active: (() => void) | null = null; // one set of shells at a time: a new style replaces the old one's index first

/**
 * Put shells on the skin mesh; returns the teardown and the shells mesh (a child of the skin). `colours`: the facial
 * hair's root and tip colours (raw sRGB), by reference, so colour changes and blends follow.
 */
export function mountShells(skin: Mesh, mask: { texture: Texture; pixels: ImageData }, look: ShellLook, colours: { root: Color; tip: Color }): { teardown: () => void; mesh: Object3D } {
  active?.();
  const geometry = skin.geometry as BufferGeometry;
  const original = geometry.index!;
  const count = original.count;
  const uv = geometry.getAttribute("uv");
  const { width, height, data } = mask.pixels;
  const cover = (v: number) => {
    const x = Math.min(width - 1, Math.max(0, Math.floor(uv.getX(v) * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(uv.getY(v) * height)));
    return data[(y * width + x) * 4];
  };
  const beard: number[] = [];
  for (let t = 0; t < count; t += 3) {
    const a = original.getX(t), b = original.getX(t + 1), c = original.getX(t + 2);
    if (Math.max(cover(a), cover(b), cover(c)) > 6) beard.push(a, b, c);
  }
  const Arr = original.array.constructor as Uint16ArrayConstructor | Uint32ArrayConstructor;
  const merged = new Arr(count + beard.length);
  merged.set(original.array as ArrayLike<number>);
  merged.set(beard, count);
  geometry.setIndex(new BufferAttribute(merged, 1));
  geometry.userData.baseIndexCount = count;
  geometry.clearGroups();
  geometry.addGroup(0, count, 0);
  geometry.addGroup(count, beard.length, 1);
  const skinMaterial = skin.material as Material;
  skin.material = [skinMaterial]; // group 1 has no material here: the skin itself never draws the copies

  const toHead = headSpaceMatrix(skin, new Matrix4());
  const metresPerUnit = new Vector3().setFromMatrixScale(toHead).x;
  const uniforms = {
    uLayers: { value: 1 },
    uLenLocal: { value: look.lengthMm / 1000 / metresPerUnit },
    uGravity: { value: look.gravity },
    uDensity: { value: look.density },
    uMask: { value: mask.texture },
    uFur: { value: fur() },
    uFurScale: { value: SHELLS.furScale },
    uTaper: { value: SHELLS.taper },
    uRootShade: { value: SHELLS.rootShade },
    uRoot: { value: colours.root },
    uTip: { value: colours.tip },
  };
  // Plain alpha blending. The layers are drawn in instance order, skin side first, which is back to front for anyone
  // looking at the face, so they composite correctly, and the fur's mipmapped coverage blends smoothly at any distance.
  // (Hashed alpha re-rolls its pattern whenever the skin moves, so the beard crawls like TV static; alpha-to-coverage
  // shimmers and comes out pale.) No depth writes: a layer never hides the one above it.
  const material = new MeshStandardMaterial({ roughness: SHELLS.roughness, metalness: 0, transparent: true, depthWrite: false });
  material.defines = { USE_UV: "" };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `uniform float uLayers, uLenLocal, uGravity, uFurScale;
uniform sampler2D uMask;
varying float vLayer, vCover;
varying vec2 vFurUv;
` + shader.vertexShader.replace("#include <morphtarget_vertex>", `#include <morphtarget_vertex>
{
  float layer = (float(gl_InstanceID) + 1.0) / uLayers;
  vec4 mk = textureLod(uMask, uv, 0.0); // r = coverage, g = length
  float len = uLenLocal * mk.g * smoothstep(0.02, 0.5, mk.r) * layer;
  vec3 n = normalize(objectNormal);
  vec3 down = vec3(0.0, -1.0, 0.0) - n * dot(vec3(0.0, -1.0, 0.0), n); // gravity, along the skin
  float dl = length(down);
  down = dl > 1e-4 ? down / dl : vec3(0.0);
  transformed += (n * (1.0 - 0.5 * uGravity) + down * uGravity * layer) * len;
  vLayer = layer;
  vCover = mk.r;
  vFurUv = uv * uFurScale;
}`);
    shader.fragmentShader = `uniform sampler2D uFur;
uniform float uTaper, uRootShade, uDensity;
uniform vec3 uRoot, uTip;
varying float vLayer, vCover;
varying vec2 vFurUv;
` + shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
{
  // the share of hair reaching this layer's height (between the four bands), thinned and shortened at the edges
  vec4 f = texture2D(uFur, vFurUv);
  float h = vLayer / mix(0.6, 1.0, smoothstep(0.1, 0.7, vCover));
  float reach = h < 0.2 ? f.r : h < 0.45 ? mix(f.r, f.g, (h - 0.2) / 0.25) : h < 0.7 ? mix(f.g, f.b, (h - 0.45) / 0.25) : h < 0.9 ? mix(f.b, f.a, (h - 0.7) / 0.2) : f.a * (1.0 - smoothstep(0.9, 1.0, h));
  float taper = 1.0 - uTaper * vLayer * vLayer; // the strands thin towards the tip
  float a = reach * taper * smoothstep(0.03, 0.5, vCover) * uDensity;
  if (a < 0.004) discard;
  vec3 rootC = sRGBTransferEOTF(vec4(uRoot, 1.0)).rgb;
  vec3 tipC = sRGBTransferEOTF(vec4(uTip, 1.0)).rgb;
  diffuseColor.rgb = mix(rootC, tipC, 0.35 + 0.6 * vLayer) * mix(uRootShade, 1.0, vLayer);
  diffuseColor.a = a;
}`).replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
material.specularColor *= ${SHELLS.specular.toFixed(2)}; // hair seen as a mat of fibres: little of the studio's white sheen
material.specularColorBlended *= ${SHELLS.specular.toFixed(2)};
material.specularF90 *= ${SHELLS.specular.toFixed(2)};`);
  };
  material.customProgramCacheKey = () => "beard-shells-v7";
  installMorph(material, "piece"); // grows out of the loader's bubble (lib/morphShader.ts)

  const layers = () => SHELLS.layers[quality.tier];
  const shells = new InstancedMesh(geometry, [NO_DRAW, material], SHELLS.layers.high);
  const identity = new Matrix4();
  for (let i = 0; i < SHELLS.layers.high; i++) shells.setMatrixAt(i, identity);
  // the skin's morph weights, live: the store and head.extra write to the skin mesh's array
  Object.defineProperty(shells, "morphTargetInfluences", { get: () => skin.morphTargetInfluences, configurable: true });
  Object.defineProperty(shells, "morphTargetDictionary", { get: () => skin.morphTargetDictionary, configurable: true });
  const setLayers = () => {
    shells.count = layers();
    uniforms.uLayers.value = layers();
  };
  setLayers();
  shells.frustumCulled = false;
  shells.renderOrder = 1;
  shells.name = "beard-shells";
  skin.add(shells); // same local space as the skin's vertices
  const stopTier = onTier(setLayers);

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    if (active === teardown) active = null;
    stopTier();
    skin.remove(shells);
    material.dispose();
    mask.texture.dispose();
    geometry.setIndex(original);
    geometry.clearGroups();
    delete geometry.userData.baseIndexCount;
    skin.material = skinMaterial;
  };
  active = teardown;
  return { teardown, mesh: shells };
}
