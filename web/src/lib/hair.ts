/**
 * Hair: strand styles (HairCS, Daniel Bystedt's demo grooms and our own procedural groom), one gzip strand file per
 * style, listed in hair/index.json (production fetches the files from Vercel Blob, see hairFileUrl). A style is fetched
 * the first time it is chosen, built by lib/groom.ts (one camera-facing ribbon per strand, more added on the GPU) and
 * attached under the head's root node. Its roots follow the skin every frame, so it follows every face the sliders can
 * make, blinks and expressions included. Recently used styles stay built in memory.
 *
 * Colour: "Natural" is the style's own root → tip colours (index.json "strands"); a swatch replaces them with its
 * shadow → highlight ramp (HAIR_COLOURS). tintStrands() fills the colour uniforms the strand shader reads.
 *
 * Style and colour are plain module state applied straight to the meshes, the same way the sliders bypass React. Hair
 * is part of the character: it is in the screenshot sent to Claude and in the cache key (lib/look.ts).
 */
import gsap from "gsap";
import { Color, type Group, LinearSRGBColorSpace, type Mesh, type MeshPhysicalMaterial, type Object3D } from "three";

import hairBlob from "@/data/hairBlob.json";
import { hairIndex, MODELS_BASE, type HairStyleDef } from "@/lib/data";
import { partDone, prefetchPart, takePrefetched } from "@/lib/headLoad";
import { MOTION } from "@/lib/motion";
import { finishPieceFade, pieceFade, swapPiece } from "@/lib/pieceFade";
import { HAIR_COLOURS, NATURAL_HAIR } from "@/lib/swatches";

/** "none" or a style id from hair/index.json ("haircs-v0-00681", "bystedt-long", …). */
export type HairStyle = "none" | (string & {});

export { HAIR_COLOURS } from "@/lib/swatches"; // plain data, shared with the server's allowlist (lib/server/look.ts)
export type HairColourId = (typeof HAIR_COLOURS)[number]["id"];

/** The Natural chip (naturalHex): `saturation` < 1 takes a style's painted colour toward its own grey. */
export const HAIR_MATERIAL = {
  natural: { saturation: 0.8 },
};

const STORAGE_KEY = "ftv-hair"; // sessionStorage: kept across reloads, but a new tab opens on the blank head
const DEFAULT_STYLE: HairStyle = "none"; // the first-visit style: a blank head; Reset uses it too
const CACHE_SIZE = 4; // built styles kept in memory (each is a few MB of GPU buffers on a phone)

/**
 * Where a style's file comes from: production fetches it from the project's Vercel Blob store (the strand files are
 * too big to commit; web/scripts/upload-hair.ts uploads them and writes data/hairBlob.json), development from
 * public/models/. A style missing from the manifest falls back to public/ (thumbnails always come from there).
 */
export function hairFileUrl(style: HairStyleDef): string {
  const path = (hairBlob.files as Record<string, string>)[style.id];
  return process.env.NODE_ENV === "production" && hairBlob.base && path ? hairBlob.base + path : MODELS_BASE + style.file;
}

export const HAIR_STYLES: readonly HairStyleDef[] = hairIndex.styles;
/** Dev builds: styles under review (pipeline haircs_review.py), resolvable by id but not listed in the picker. */
const reviewStyles = new Map<string, HairStyleDef>();
export const hairStyleById = (id: string): HairStyleDef | undefined => HAIR_STYLES.find((s) => s.id === id) ?? reviewStyles.get(id);

/** Dev only (/dev/hair-review and its capture script): load the review set so setHairStyle(id) can show any of them. */
export async function loadReviewStyles(): Promise<HairStyleDef[]> {
  if (process.env.NODE_ENV === "production") return [];
  const r = await fetch(MODELS_BASE + "hair/review/review.json");
  if (!r.ok) return [];
  const list = ((await r.json()) as { styles: HairStyleDef[] }).styles;
  for (const s of list) reviewStyles.set(s.id, s);
  return list;
}

export const hairRig = {
  /** The style currently on the head: its strand group (userData.style = its id). It is part of the face screenshot. */
  mesh: null as Group | null,
  /** The head's root node, set by Head.tsx; styles are attached here so they nod with the bust. */
  parent: null as Object3D | null,
  /** True while a style's file is on its way. */
  loading: false,
  /** Development: a strand file is missing (404), so the hair files aren't installed; HairControl says how to get them. */
  filesMissing: false,
};
/** What a first visit shows; also what the server renders, so the control hydrates cleanly. */
export const HAIR_DEFAULTS = { style: DEFAULT_STYLE as HairStyle, colour: "natural" as HairColourId };
export const hairState: { style: HairStyle; colour: HairColourId } = { ...HAIR_DEFAULTS };

// --- UI sync (useSyncExternalStore in HairControl) -------------------------------------------

export type HairSnapshot = { style: HairStyle; colour: HairColourId; loading: boolean; filesMissing: boolean };
/** What the server renders (and the client's first paint), before sessionStorage is consulted. */
export const HAIR_SERVER_SNAPSHOT: HairSnapshot = { ...HAIR_DEFAULTS, loading: false, filesMissing: false };
let snapshot: HairSnapshot = HAIR_SERVER_SNAPSHOT;

/** `blendSeconds` > 0: the colour is blending (Random character), and whatever follows it should blend as long (addons.ts). */
type Listener = (blendSeconds?: number) => void;
const listeners = new Set<Listener>();
/** Fires on every style, colour or loading change. */
export function onHairChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
/** Immutable snapshot for React (same reference until something changes). Restores the saved choice on first use. */
export function hairSnapshot(): HairSnapshot {
  loadHairState();
  return snapshot;
}
const notify = (blendSeconds = 0) => {
  snapshot = { style: hairState.style, colour: hairState.colour, loading: hairRig.loading, filesMissing: hairRig.filesMissing };
  for (const fn of listeners) fn(blendSeconds);
};

let loaded = false;
/** Restore the last choice (idempotent; the control and the head both call it; safe without a window). */
function loadHairState(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof window !== "undefined" ? window.sessionStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<typeof hairState>;
    if (saved.style === "none" || (saved.style && hairStyleById(saved.style))) hairState.style = saved.style;
    else if (saved.style === "short") hairState.style = "haircs-v0-00681"; // the old procedural shell → a crop
    if (HAIR_COLOURS.some((c) => c.id === saved.colour)) hairState.colour = saved.colour as HairColourId;
    if (saved.style !== hairState.style) persist(); // migrated or unknown style: store what we show
  } catch {
    /* private mode or malformed: keep defaults */
  }
  notify();
}

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(hairState));
  } catch {
    /* private mode: nothing to do */
  }
}

// --- materials --------------------------------------------------------------------------------

const hexInt = (hex: string) => parseInt(hex.slice(1), 16);
/** Mix two sRGB hex colours in sRGB space (what a painter would do), as a hex int. */
export function mixHex(a: string, b: string, t: number): number {
  const ca = hexInt(a), cb = hexInt(b);
  let out = 0;
  for (const shift of [16, 8, 0]) out |= Math.round(((ca >> shift) & 255) * (1 - t) + ((cb >> shift) & 255) * t) << shift;
  return out;
}

/**
 * The colour state of one strand piece: the root (shadow) and tip (highlight) colours its shader reads, shared by
 * reference. The hair has one set (one style is on the head at a time); every add-on made of strands, stubble or
 * shells (lib/addons.ts) has its own, so a beard can wear another colour than the hair. tintStrands() fills a set.
 * The colours are stored as raw sRGB values (LinearSRGBColorSpace skips three's conversion) so the shader can mix them
 * perceptually and decode the result; a linear mix would wash every swatch out.
 */
export const strandColours = () => ({
  uniforms: {
    uHairShadow: { value: new Color() },
    uHairHighlight: { value: new Color() },
  },
});
export type StrandColours = ReturnType<typeof strandColours>;

type HairColour = (typeof HAIR_COLOURS)[number];
export const hairColourById = (id: string): HairColour => HAIR_COLOURS.find((c) => c.id === id) ?? NATURAL_HAIR;

/** A two-tone ramp (sRGB hex), or null: keep the piece's own colours (a stubble or shell beard's painted Natural). */
export type StrandRamp = { shadow: string; highlight: string } | null;
export const rampOf = (colour: HairColour): StrandRamp => ("shadow" in colour ? colour : null);

/**
 * Fill a colour set with a ramp (null leaves it as it is). `darken` (0..1) takes the ramp toward `toward`: black for
 * eyelashes (they stay dark on a platinum blonde), the ramp's own shadow colour for eyebrows (a shade darker than the
 * hair in the hair's own hue; toward black a blonde brow turns olive). See lib/addons.ts.
 */
export function tintStrands(colours: StrandColours, colour: StrandRamp, darken = 0, toward: "black" | "shadow" = "black"): void {
  blends.get(colours)?.kill(); // an instant change wins over a blend in progress
  blends.delete(colours);
  if (colour === null) return;
  const u = colours.uniforms;
  const dark = toward === "shadow" ? colour.shadow : "#000000";
  u.uHairShadow.value.setHex(mixHex(colour.shadow, dark, darken), LinearSRGBColorSpace); // raw sRGB, see strandColours
  u.uHairHighlight.value.setHex(mixHex(colour.highlight, dark, darken), LinearSRGBColorSpace);
}

const blends = new WeakMap<StrandColours, gsap.core.Tween>();

/**
 * Blend a colour set to the state tintStrands() would give a fresh set, over `seconds` (Random character: the hair
 * colour changes along with the face morph). The colours are raw sRGB, so the mix is perceptual.
 */
export function blendStrands(colours: StrandColours, seconds: number, ...args: Parameters<typeof tintStrands> extends [unknown, ...infer R] ? R : never): void {
  // A null ramp keeps the piece's own colours, as in tintStrands: a fresh set is black, so there is nothing to blend toward.
  if (args[0] === null) return tintStrands(colours, ...args);
  const target = strandColours();
  tintStrands(target, ...args);
  const u = colours.uniforms, to = target.uniforms;
  const from = { shadow: u.uHairShadow.value.clone(), highlight: u.uHairHighlight.value.clone() };
  const mix = { t: 0 };
  blends.get(colours)?.kill();
  blends.set(
    colours,
    gsap.to(mix, {
      t: 1,
      duration: seconds,
      ease: MOTION.ease.morph, // blends with the morph
      onUpdate: () => {
        u.uHairShadow.value.lerpColors(from.shadow, to.uHairShadow.value, mix.t);
        u.uHairHighlight.value.lerpColors(from.highlight, to.uHairHighlight.value, mix.t);
      },
      onComplete: () => blends.delete(colours),
    }),
  );
}

/** Push the current colour onto the attached style (no-op until one is attached); `seconds` > 0 blends it. */
function applyHair(seconds = 0): void {
  const group = hairRig.mesh;
  if (!group) return;
  group.visible = hairState.style !== "none";
  const style = hairStyleById(group.userData.style as string);
  const colour = hairColourById(hairState.colour);
  const colours = group.userData.colours as StrandColours;
  // A style's Natural is its own root → tip ramp.
  const ramp = rampOf(colour) ?? (style?.strands ? { shadow: style.strands.root, highlight: style.strands.tip } : null);
  if (seconds > 0) blendStrands(colours, seconds, ramp);
  else tintStrands(colours, ramp);
}

/** A painted colour as Natural renders it: HAIR_MATERIAL.natural.saturation applied (toward its own grey, in sRGB). */
export function naturalHex(hex: string): string {
  const c = hexInt(hex);
  const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = HAIR_MATERIAL.natural.saturation;
  return "#" + [r, g, b].map((v) => Math.round(grey + (v - grey) * s).toString(16).padStart(2, "0")).join("");
}

/** The chip colour of a swatch for a style: Natural shows the style's own painted colour, as the head renders it. */
export function hairChipHex(colour: HairColourId, style: HairStyle): string {
  const def = HAIR_COLOURS.find((c) => c.id === colour) ?? NATURAL_HAIR;
  if (def.id !== "natural") return def.hex;
  return naturalHex(hairStyleById(style)?.natural ?? def.hex);
}

// --- loading --------------------------------------------------------------------------------

/**
 * The one glTF loader, for the glasses (lib/addons.ts) and head.extra.glb (lib/headExtra.ts); the loader, decoder and
 * their code are fetched on first use. Decoding runs in two workers, so a file arriving mid-animation doesn't stall the
 * main thread.
 */
let loaderPromise: Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader> | null = null;
export function gltfLoader() {
  loaderPromise ??= Promise.all([import("three/examples/jsm/loaders/GLTFLoader.js"), import("three/examples/jsm/libs/meshopt_decoder.module.js")]).then(
    ([{ GLTFLoader }, { MeshoptDecoder }]) => {
      MeshoptDecoder.useWorkers(2);
      return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    },
  );
  // A failed import (a network blip) must not be remembered: the next style click tries again.
  loaderPromise.catch(() => {
    loaderPromise = null;
  });
  return loaderPromise;
}

/** Fetch a style's strand file (abortable) and build it (lib/groom.ts). */
async function loadStyle(style: HairStyleDef, signal: AbortSignal): Promise<Group> {
  if (style.kind !== "strands" || !style.strands) throw new Error(`${style.id}: not a strand style`); // every style is strands
  const url = hairFileUrl(style);
  // The first visit's style was already fetched at hydration (prefetchHair); everything else fetches now.
  const download =
    takePrefetched(url) ??
    fetch(url, { signal }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); // never hand a 404 page to the decoder
      return r.arrayBuffer();
    });
  // Strands drawn by lib/groom.ts (no glTF, no morph targets): the roots follow the skin every frame, since a blink
  // moves the hairline skin and the scalp tint on it. Awaited together: a download failing first is still handled.
  const [{ buildGroom }, bytes] = await Promise.all([import("@/lib/groom"), download]);
  const group = await buildGroom(style.strands, bytes, strandColours());
  group.userData.style = style.id;
  return group;
}

export function meshesOf(group: Object3D): Mesh[] {
  const out: Mesh[] = [];
  group.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

/** Free a piece's GPU buffers, textures and decoded images (hair styles and add-ons). */
export function disposePiece(group: Object3D): void {
  (group.userData.dispose as (() => void) | undefined)?.(); // a groom's data textures, a stand-in's skin switch-off
  const seen = new Set<object>();
  for (const m of meshesOf(group)) {
    if (!seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const material = m.material as MeshPhysicalMaterial;
    for (const tex of [material.map, material.normalMap, material.metalnessMap, material.roughnessMap, material.aoMap, material.emissiveMap]) { // glasses carry metal/roughness
      if (tex && !seen.has(tex)) {
        seen.add(tex);
        tex.dispose();
        (tex.source.data as { close?: () => void } | null)?.close?.(); // GLTFLoader decodes to ImageBitmaps: free them too
      }
    }
    material.dispose();
  }
}

/** Built styles by id, most recently used last; bounded so a phone never holds every style. */
const cache = new Map<string, Group>();
function remember(id: string, group: Group): void {
  cache.delete(id);
  cache.set(id, group);
  while (cache.size > CACHE_SIZE) {
    const [oldest, stale] = cache.entries().next().value as [string, Group];
    cache.delete(oldest);
    if (stale !== hairRig.mesh && !pieceFade.leaving.some((l) => l.node === stale)) disposePiece(stale); // not while it fades out
  }
}

/**
 * Put a style on the head. The old style stays on until the new one is ready (no bald flash). With `crossfade`
 * (Random character, Reset) the swap joins the open batch in lib/pieceFade.ts: the old style is removed when the fade
 * ends. Otherwise (the Style tab) it is swapped at once. Strands follow the skin themselves (no morph binding).
 */
function attach(group: Group, parent: Object3D, crossfade = false): void {
  swapOut(group, crossfade);
  parent.add(group);
  hairRig.mesh = group;
  applyHair();
}

/** Take the current style off for `next` (null = no hair): now, or at the end of the batch's fade. */
function swapOut(next: Group | null, crossfade: boolean): void {
  const old = hairRig.mesh;
  hairRig.mesh = null;
  const later = () => {
    if (!old || hairRig.mesh === old) return; // unless it was chosen again meanwhile
    old.removeFromParent();
    if (cache.get(old.userData.style as string) !== old) disposePiece(old); // left the cache while it faded out (remember())
  };
  if (crossfade && swapPiece(old, next, later)) return;
  old?.removeFromParent();
}

function detachCurrent(): void {
  swapOut(null, false);
}

// A slow earlier load must never override a newer choice: only the latest request attaches, and
// the superseded fetch is aborted.
let request = 0;
let inflight: AbortController | null = null;

/** Attach (or fetch, then attach) the style in hairState.style. No-op until the head is mounted. `crossfade`: see attach(). */
async function syncHair(crossfade = false): Promise<void> {
  const id = ++request;
  inflight?.abort();
  inflight = null;
  const style = hairState.style === "none" ? undefined : hairStyleById(hairState.style);
  if (!style || !hairRig.parent) {
    swapOut(null, crossfade && !!hairRig.parent);
    hairRig.loading = false;
    if (hairRig.parent) partDone("hair"); // "none" on a mounted head: nothing to wait for
    notify();
    return;
  }
  if (hairRig.mesh?.userData.style === style.id) {
    applyHair();
    hairRig.loading = false; // an older fetch may have set it; its finally() will not clear it (id !== request)
    partDone("hair");
    notify();
    return;
  }
  const cached = cache.get(style.id);
  if (cached) {
    remember(style.id, cached);
    attach(cached, hairRig.parent, crossfade);
    hairRig.loading = false;
    partDone("hair");
    notify();
    return;
  }
  hairRig.loading = true;
  notify();
  const controller = (inflight = new AbortController());
  try {
    const group = await loadStyle(style, controller.signal);
    if (id !== request || !hairRig.parent) {
      disposePiece(group); // superseded (or the head went away) while parsing: throw it away
      return;
    }
    remember(style.id, group);
    attach(group, hairRig.parent, crossfade);
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("hair: failed to load", style.file, err);
      // Show what is really on the head: the picker goes back to the attached style (or None). Stored too, so a reload
      // doesn't ask for the failed file again.
      if (id === request) {
        hairState.style = (hairRig.mesh?.userData.style as HairStyle | undefined) ?? "none";
        persist();
      }
      if (process.env.NODE_ENV !== "production") void checkHairFiles(style);
    }
  } finally {
    if (id === request) {
      inflight = null;
      hairRig.loading = false;
      partDone("hair"); // attached or failed: the loader's reveal stops waiting either way
      notify();
    }
  }
}

/**
 * Development: a strand file that is not there (404) means the hair files aren't installed: they are too big for the
 * repo, and `pnpm fetch-hair` (scripts/fetch-hair.ts) downloads them. Asked with one HEAD request after a failed load,
 * since the failure may come from an earlier download (lib/headLoad.ts prefetch or preload) that carries no status.
 */
async function checkHairFiles(style: HairStyleDef): Promise<void> {
  if (hairRig.filesMissing) return;
  const r = await fetch(hairFileUrl(style), { method: "HEAD" }).catch(() => null);
  if (r?.status !== 404) return;
  hairRig.filesMissing = true;
  notify();
}

/** FaceCanvas, at hydration: start downloading the saved (or default) style now, so it is on the head at the reveal. */
export function prefetchHair(): void {
  loadHairState();
  const style = hairState.style === "none" ? undefined : hairStyleById(hairState.style);
  if (style) prefetchPart("hair", hairFileUrl(style));
}

/** Head.tsx: the head's root node exists; attach the chosen style under it. */
export function mountHair(parent: Object3D): void {
  loadHairState();
  hairRig.parent = parent;
  void syncHair();
}

/** Head.tsx cleanup: drop the styles with the head (a remount fetches them again, from the HTTP cache). */
export function unmountHair(): void {
  request++; // any load in flight is discarded when it lands
  inflight?.abort();
  inflight = null;
  finishPieceFade(); // a fade in progress ends with the head
  detachCurrent();
  for (const group of cache.values()) disposePiece(group);
  cache.clear();
  hairRig.parent = null;
  hairRig.loading = false;
  notify();
}

/** Resolves once the style is on the head (or failed, or was superseded). `crossfade`: join lib/pieceFade.ts's open batch. */
export function setHairStyle(style: HairStyle, crossfade = false): Promise<void> {
  hairState.style = style;
  persist();
  return syncHair(crossfade);
}

/** `seconds` > 0 blends the colour (Random character and Reset, with the morph; brows, lashes and beard follow as long). */
export function setHairColour(colour: HairColourId, seconds = 0): void {
  hairState.colour = colour;
  persist();
  applyHair(seconds);
  notify(seconds);
}
