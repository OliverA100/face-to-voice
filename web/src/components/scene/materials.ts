/**
 * Materials for every part of the head. This is the file to tweak for the look.
 *
 * Colours are sRGB hex (three converts them). One instance per material name is shared by
 * the left/right eye parts. Cheap by design: no transmission; lighting comes from the
 * environment map in Lighting.tsx plus a key and a fill light; nothing casts or receives
 * shadows. Hair materials live in lib/hair.ts.
 *
 * The look is a neutral product render on a light backdrop: muted, matte skin (no pink or
 * orange cast, so the voice orbs stay the only saturated colour on the page), eyes with a
 * softened clearcoat for a small catchlight, teeth a touch off-white.
 */
import { AdditiveBlending, Color, MeshPhysicalMaterial } from "three";

import { eyeHex } from "@/lib/eyes";
import { installIrisShader, installScleraShader } from "@/lib/eyeShader";
import { installMorph } from "@/lib/morphShader";
import { installMouthShade } from "@/lib/mouthShade";
import { skinHex, skinSheen } from "@/lib/skin";
import { installSkinShader } from "@/lib/skinShader";

type Factory = () => MeshPhysicalMaterial;

const FACTORIES: Record<string, Factory> = {
  skin: () => {
    const m = new MeshPhysicalMaterial({
      color: new Color(skinHex()), // the visitor's skin tone (lib/skin.ts)
      roughness: 0.74,
      metalness: 0,
      specularIntensity: 0.25,
      ior: 1.4, // skin
      sheen: 0.08, // faint peach-fuzz rim
      sheenRoughness: 0.9,
      sheenColor: skinSheen(),
    });
    installSkinShader(m); // ageing + baked AO (lib/skinShader.ts)
    return m;
  },
  // Inside the mouth: each part darkens with depth behind the lips (lib/mouthShade.ts).
  mouth: () => mouthPart({ color: new Color("#4d2327"), roughness: 0.75 }),
  gums: () => mouthPart({ color: new Color("#a8565d"), roughness: 0.5, specularIntensity: 0.7 }),
  teeth: () => mouthPart({ color: new Color("#ece6dc"), roughness: 0.35, specularIntensity: 0.8 }),
  tongue: () => mouthPart({ color: new Color("#a9505a"), roughness: 0.55, sheen: 0.3, sheenColor: new Color("#f0a0a0") }),
  // Eyes (lib/eyeShader.ts): iris, pupil and sclera are drawn from their UVs; the wet gloss comes from the cornea.
  sclera: () => {
    const m = new MeshPhysicalMaterial({ color: new Color("#e6e4e1"), roughness: 0.45, metalness: 0 });
    installScleraShader(m);
    return m;
  },
  iris: () => {
    const m = new MeshPhysicalMaterial({ color: new Color(eyeHex()), roughness: 0.55, metalness: 0 }); // the visitor's eye colour (lib/eyes.ts)
    installIrisShader(m); // the pupil mesh shares it (materialFor)
    return m;
  },
  // The clear eye shell: black and additive, so only its reflections show (the catchlight and the wet sheen).
  cornea: () => new MeshPhysicalMaterial({
    color: new Color("#000000"), roughness: 0.04, metalness: 0, specularIntensity: 1, ior: 1.376,
    envMapIntensity: 0.7, transparent: true, blending: AdditiveBlending, depthWrite: false,
  }),
};

function mouthPart(params: ConstructorParameters<typeof MeshPhysicalMaterial>[0]): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({ metalness: 0, ...params });
  installMouthShade(m);
  return m;
}

const cache = new Map<string, MeshPhysicalMaterial>();

/** Mesh/node names are "skin", "sclera_L", "iris_R", …; the material is the name without _L/_R. */
export function materialFor(partName: string): MeshPhysicalMaterial {
  const name = partName.replace(/_[LR]$/, "");
  const key = name === "pupil" ? "iris" : name; // the pupil is a disc in the iris shader: one material for both
  let m = cache.get(key);
  if (!m) {
    const make = FACTORIES[key] ?? FACTORIES.skin;
    m = make();
    installMorph(m, key); // the loader's morph reveal: the bubble becomes this part (lib/morphShader.ts)
    m.name = key;
    cache.set(key, m);
  }
  return m;
}

export function disposeMaterials(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
