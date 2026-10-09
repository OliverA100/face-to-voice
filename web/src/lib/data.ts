/**
 * Typed access to the pipeline's outputs (sliders.json, visemes.json, head.manifest.json, the hair and add-on
 * indexes): the shapes below are the contract the web app relies on.
 */
import slidersJson from "@/data/sliders.json";
import type { GroomDef } from "@/lib/groom";
import visemesJson from "@/data/visemes.json";
import eyebrowsIndexJson from "../../public/models/addons/eyebrows/index.json";
import eyelashesIndexJson from "../../public/models/addons/eyelashes/index.json";
import facialHairIndexJson from "../../public/models/addons/facialHair/index.json";
import glassesIndexJson from "../../public/models/addons/glasses/index.json";
import hairIndexJson from "../../public/models/hair/index.json";
import manifestJson from "../../public/models/head.manifest.json";

/**
 * identity / expression / preset: raw GNM components (the Advanced section), numbered per area.
 * semantic: one facial feature each (pipeline/config/semantic_sliders.toml, the Identity section).
 * emotion: an upper- or lower-face emotion target, driven by lib/emotion.ts (never shown as a slider).
 * control: a fine-tune expression control (jaw open, smile …, the Emotion section), always a `combo`.
 * pose: a head or gaze angle in degrees (the Pose section, lib/pose.ts); not a morph target.
 */
type SliderKind = "identity" | "expression" | "preset" | "semantic" | "emotion" | "control" | "pose";

/** Panel sections, top to bottom. */
type SectionId = "identity" | "emotion" | "pose" | "advanced";

export interface SliderDef {
  id: string;
  target: string; // morph target name in head.glb
  kind: SliderKind;
  section?: SectionId; // missing = advanced
  region: string;
  name: string;
  description: string;
  lowLabel: string;
  highLabel: string;
  group: string;
  min: number;
  max: number;
  default: number;
  hidden: boolean;
  /** A mix slider: no morph target of its own; its value is spread over these targets (lib/morphs/store.ts). */
  combo?: Record<string, number>;
  /** A two-sided mix: the weights used below zero (× |value|) instead of `combo` reversed. */
  comboNeg?: Record<string, number>;
  /** "deg" for pose sliders. */
  unit?: string;
}

interface EmotionDef {
  id: string; // "happy" (also the id sent to the speak route)
  label: string;
  upper: string; // morph target of the eyes-and-brows part
  lower: string; // morph target of the mouth part
}

interface SlidersDoc {
  version: number;
  sections: { id: SectionId; label: string }[];
  groups: { id: string; label: string; section?: SectionId }[];
  sliders: SliderDef[];
  emotions: { intensity: { min: number; max: number; default: number }; items: EmotionDef[] };
}

/** A preset: morph weights per target (-1..1), e.g. one viseme or one blink. */
export type Weights = Record<string, number>;

interface VisemesDoc {
  visemes: Record<string, Weights>;
  roles: { blinkLeft: Weights; blinkRight: Weights; jawOpen: Weights; pupils: Weights };
  /** mm of lip opening and jaw opening per unit morph weight (LipSync's speed limit). */
  speed?: { gap: Weights; jaw: Weights };
}

export interface Manifest {
  /** head.extra.glb: more morph targets for the same meshes, loaded after the first view (lib/headExtra.ts). */
  extra?: { file: string } | null;
  sigma_scale: number;
  bounds: { min: number[]; max: number[] };
  targets: { name: string; kind: SliderKind; region: string; scale: number; max_delta_mm: number; meshes: string[]; file?: "base" | "extra" }[];
  meshes: { name: string; material: string; node: string; vertices: number; triangles: number; targets: string[] }[];
  nodes: Record<string, { pivot: number[]; identity_pivot_basis: Record<string, number[]> }>;
}

/** One hair style: strands from HairCS, Bystedt's demo grooms or our own groom (pipeline haircs_review.py, import_hair.py,
 * export_groom.py), index v2. */
export interface HairStyleDef {
  id: string;
  label: string;
  file: string; // "hair/<id>.strands.bin" or "hair/haircs/<id>.strands.bin", relative to MODELS_BASE
  thumb: string; // "hair/thumbs/<id>.webp", 128×128
  bytes: number;
  natural: string; // "#rrggbb": alpha-weighted mean colour of the painted texels (the Natural chip)
  author: string; // credited in NOTICE / README
  pack: "groom" | "haircs"; // our own and Bystedt's grooms (by author), or HairCS in its own folder (hair/haircs: CC BY-NC 4.0)
  /** always "strands" (drawn by lib/groom.ts) */
  kind?: "strands";
  strands?: GroomDef;
  /** the picker's length filter (pipeline haircs_review.py apply) */
  group?: HairGroup;
  /** wavy or curly (also listed under the Curly filter) */
  curly?: boolean;
  /** finer kind inside the group ("undercut", "lob", "high-ponytail" …): the picker shows similar styles together */
  type?: string;
  fringe?: "none" | "full" | "side" | "curtain";
}

export type HairGroup = "short" | "bob" | "shoulder" | "long" | "tied";

const HAIR_INDEX_VERSION = 2;

interface HairIndex {
  version: typeof HAIR_INDEX_VERSION;
  licence: string;
  styles: HairStyleDef[];
}

/** The add-on categories, in panel order. Each has its own folder and index under /models/addons/. */
export const ADDON_CATEGORIES = ["eyebrows", "eyelashes", "facialHair", "glasses"] as const;
export type AddonCategory = (typeof ADDON_CATEGORIES)[number];

/** One add-on (pipeline brow_strands.py, lash_strands.py, beard_strands.py, stubble.py, glasses_gen.py), index v1. */
export interface AddonStyleDef {
  id: string; // unique inside its category only ("natural" is both a brow and a lash style)
  label: string;
  file: string; // "addons/<category>/<id>.<strands.bin|ktx2|png|glb>", relative to MODELS_BASE
  thumb: string; // "addons/<category>/thumbs/<id>.webp", 128×128
  vertices: number;
  triangles: number;
  bytes: number;
  targets: number;
  author: string;
  pack: string;
  natural: string; // as for hair; means nothing for glasses
  lum: { median: number; p98: number };
  alphaCutoff: number;
  tint: boolean; // informational (the app decides by category): true = strands that take a hair colour, false = shown as painted (glasses)
  /** "strands": grown strands, drawn by lib/groom.ts; "stubble": drawn in the skin shader (pipeline stubble.py, file = its
   *  coverage mask); "shells": a short beard (lib/beardShells.ts); absent = glasses (.glb) */
  kind?: "strands" | "stubble" | "shells";
  strands?: GroomDef;
  /** A stubble style's look: how much of the stubs show, the even shadow under them, and its Natural colours. */
  stubble?: { length: number; shadow: number; root: string; tip: string };
  /** A strand beard's stubble under it (its outline in the skin's UVs, like a stubble style's file); look in `stubble`. */
  stubbleMask?: string;
  /** A short beard drawn as shells (lib/beardShells.ts); file = its mask (PNG: R coverage, G length). */
  shells?: { lengthMm: number; gravity: number; density: number; shadow: number; root: string; tip: string };
  /** Generated glasses (pipeline glasses_gen.py): what the frame is made of and how the lens looks. */
  glasses?: GlassesLook;
}

export interface GlassesLook {
  kind: string; // acetate | metal | browline | halfrim | rimless
  shape: string;
  acetate: boolean; // a glossy plastic front (clearcoat)
  lens: { tint: string; opacity: number; gradient: number; mirror: number };
}

interface AddonIndex {
  version: 1;
  category: AddonCategory;
  licence: string;
  styles: AddonStyleDef[];
}

export const sliders = slidersJson as unknown as SlidersDoc;
export const visemes = visemesJson as unknown as VisemesDoc;
export const manifest = manifestJson as unknown as Manifest;
export const hairIndex = hairIndexJson as unknown as HairIndex;
if (process.env.NODE_ENV !== "production" && (hairIndex.version as number) !== HAIR_INDEX_VERSION) {
  console.warn(`hair/index.json is version ${hairIndex.version}, the app expects ${HAIR_INDEX_VERSION}: regenerate it (pipeline export-groom / haircs-review)`);
}

export const addonIndex: Record<AddonCategory, AddonIndex> = {
  eyebrows: eyebrowsIndexJson as unknown as AddonIndex,
  eyelashes: eyelashesIndexJson as unknown as AddonIndex,
  facialHair: facialHairIndexJson as unknown as AddonIndex,
  glasses: glassesIndexJson as unknown as AddonIndex,
};

/** Versioned (next.config.ts assetVersion): cached for a year, a new URL whenever the files change. */
export const ASSET_ROOT = process.env.FTV_ASSET_V ? `/v/${process.env.FTV_ASSET_V}/` : "/";
export const MODELS_BASE = `${ASSET_ROOT}models/`;
export const MODEL_URL = `${MODELS_BASE}head.glb`;

/** Sliders the UI shows, in group order. */
export function visibleSliders(): SliderDef[] {
  return sliders.sliders.filter((s) => !s.hidden);
}

export const sectionOf = (s: { section?: SectionId }): SectionId => s.section ?? "advanced";

/** The emotion buttons, in panel order (sliders.json v2 "emotions"). */
export const emotionDefs: EmotionDef[] = sliders.emotions?.items ?? [];

/** Preset weights for a viseme. visemes.json uses lowercase keys ("pp"); the cue engine uses "PP". */
export function visemePreset(id: string): Weights {
  return visemes.visemes[id.toLowerCase()] ?? visemes.visemes[id] ?? {};
}
