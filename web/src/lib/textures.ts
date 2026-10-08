/**
 * KTX2 textures (Basis Universal, made by the pipeline with basisu): small downloads that stay compressed on the GPU.
 * The transcoder (public/basis/, ~0.2 MB brotli) loads lazily on the first request, which the head makes only after
 * it is on screen, so the first view never waits for it. KTX2 images are top-row-first like glTF, matching the UVs.
 */
import { NoColorSpace, SRGBColorSpace, type Texture, type WebGLRenderer } from "three";
import type { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

import { ASSET_ROOT } from "@/lib/data";
import { quality, TIERS } from "@/lib/quality";

export const TEXTURES_BASE = `${ASSET_ROOT}textures/`;

let loader: Promise<KTX2Loader> | null = null;
let renderer: WebGLRenderer | null = null;
const cache = new Map<string, Promise<Texture>>();

/** Head.tsx hands over the renderer (the transcoder picks a GPU format the device supports). */
export function setTextureRenderer(gl: WebGLRenderer): void {
  renderer = gl;
}

function ktx2(): Promise<KTX2Loader> {
  if (!renderer) return Promise.reject(new Error("textures: no renderer yet"));
  if (!loader) {
    const pending = import("three/examples/jsm/loaders/KTX2Loader.js").then(({ KTX2Loader }) =>
      new KTX2Loader().setTranscoderPath(`${ASSET_ROOT}basis/`).setWorkerLimit(2).detectSupport(renderer!),
    );
    loader = pending;
    pending.catch(() => loader === pending && (loader = null)); // a network blip: the next texture tries again
  }
  return loader;
}

/** A texture failed on `l`: if its transcoder (public/basis/) is what failed, KTX2Loader keeps that failure for good, so
 *  the next texture gets a fresh loader. */
async function dropIfBroken(from: Promise<KTX2Loader>, l: KTX2Loader): Promise<void> {
  const broken = await l.init().then(
    () => false,
    () => true,
  );
  if (!broken || loader !== from) return;
  loader = null;
  l.dispose();
}

/** `name` without size suffix ("skin_regions"): the low tier gets name@512.ktx2, the others name.ktx2. */
export function tieredUrl(name: string): string {
  return TEXTURES_BASE + (TIERS[quality.tier].textureSize < 1024 ? `${name}@512.ktx2` : `${name}.ktx2`);
}

/** Load (once) a KTX2 texture; `srgb` for colour maps, data maps (AO, roughness, normals) stay linear. A failed load
 *  isn't kept: the next call tries again. */
export function loadKtx2(url: string, srgb = false): Promise<Texture> {
  let p = cache.get(url);
  if (!p) {
    const from = ktx2();
    const pending = from.then(async (l) => {
      const tex = await l.loadAsync(url).catch(async (err: unknown) => {
        await dropIfBroken(from, l);
        throw err;
      });
      tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      tex.anisotropy = 4;
      return tex;
    });
    pending.catch(() => cache.get(url) === pending && cache.delete(url));
    cache.set(url, (p = pending));
  }
  return p;
}
