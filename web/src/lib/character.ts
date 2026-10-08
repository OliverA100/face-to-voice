/**
 * Random character and Reset, the two buttons over the head (components/ui/Toolbar.tsx).
 *
 * Random character: a whole new person in one click. A random face (lib/morphs/random.ts) plus a random
 * age, skin and eye colour, hair and hair colour, brows, lashes, maybe a beard, maybe glasses, and an
 * emotion. Pose is left alone. Every piece goes through the same setters the panel uses, so the panel,
 * the saved choices and the voice's look all follow.
 *
 * The change (`transition` below): the face morphs into the new one while the skin, eye and hair colours blend on
 * the live head and the emotion blends in. CHARACTER.styleAt seconds after the morph starts (once their files have
 * downloaded) the old hair and add-ons cross-fade to the new ones (lib/pieceFade.ts: the head is rendered with the
 * old pieces and with the new ones, both live and opaque, and the two frames are mixed), so there is never a second
 * face and no see-through hair. The simpler options don't hold up: a screenshot cross-fade over the morph shows a
 * double image, a dip to the backdrop hides the morph, and fading the pieces themselves dissolves or turns patchy.
 *
 * Tweak the odds and timings in CHARACTER.
 */
import { precompile } from "@/components/scene/Capture";
import {
  ADDON_CATEGORIES,
  ADDON_DEFAULTS,
  addonState,
  addonStyleById,
  addonStyles,
  setAddonStyle,
  setFacialHairColour,
  type AddonCategory,
  type AddonStyle,
  type FacialHairColour,
} from "@/lib/addons";
import { NATURAL_HAIR } from "@/lib/swatches";
import { emotionDefs, MODELS_BASE, sliders, visibleSliders } from "@/lib/data";
import { AGE } from "@/lib/age";
import { NEUTRAL, setEmotion, setIntensity } from "@/lib/emotion";
import { EYE_COLOURS, EYE_DEFAULT, setEyeColour, type EyeColourId } from "@/lib/eyes";
import { HAIR_COLOURS, HAIR_DEFAULTS, HAIR_STYLES, hairFileUrl, hairState, hairStyleById, setHairColour, setHairStyle, type HairColourId, type HairStyle } from "@/lib/hair";
import { preload } from "@/lib/headLoad";
import { finishPieceFade, openPieceFade, pieceFade, runPieceFade } from "@/lib/pieceFade";
import { clearRandomFace, randomFace } from "@/lib/morphs/random";
import { MOTION } from "@/lib/motion";
import { morphs } from "@/lib/morphs/store";
import { centrePose } from "@/lib/pose";
import { setSkinTone, SKIN_DEFAULT, SKIN_TONES, type SkinToneId } from "@/lib/skin";

/** Tweak freely. Chances are 0..1; weights are relative. */
export const CHARACTER = {
  duration: MOTION.morph, // seconds for the face to morph into the new one (colours, expression and pose change as long)
  styleAt: 0, // seconds after the morph starts when the hair and add-ons cross-fade: 0 = with the morph, 0.9 = after it
  styleFade: MOTION.crossfade, // seconds for the old hair and add-ons to fade out and the new ones in
  maxDownload: 3, // seconds to wait for new hair / add-on files before changing anyway (they then pop in late)
  maxAttach: 1, // seconds to wait for them to be built and attached (and again for their shaders) before fading anyway
  age: [-0.7, 0.9] as const, // the Age slider's random range (−1 young … +1 old)
  bald: 0.08, // chance of no hair …
  baldWhenOld: 0.25, // … once Age is past `old`
  old: 0.5, // Age from which grey and white hair become likely
  greyWhenOld: 0.6, // chance of grey or white hair past `old`
  facialHair: 0.25,
  glasses: 0.25,
  /** Hair colours when not grey: "natural" shows the style's own painted colour. */
  hairColours: {
    natural: 3, black: 2, "dark-brown": 2, brown: 2, auburn: 1, blonde: 1, platinum: 0.4, ginger: 0.6,
    // dyed: about one random character in fifteen
    "pastel-pink": 0.15, "hot-pink": 0.1, "cherry-red": 0.15, purple: 0.1, lavender: 0.1, "electric-blue": 0.1, teal: 0.1, green: 0.05,
  } as Record<string, number>,
  /** Emotions: neutral and happy come up most, the rest now and then. Unlisted emotions weigh 1. */
  emotions: { [NEUTRAL]: 3, happy: 3 } as Record<string, number>,
  intensity: [0.35, 0.9] as const,
  /**
   * Distinctiveness of the face (lib/morphs/random.ts): chance of each band; a band rolls uniformly in [from, to].
   * 1 = a typical face; above 1 a few Feature sliders head toward their wide ends. The panel's slider shows the roll.
   */
  distinctiveness: [
    { chance: 0.7, from: 1, to: 1 },
    { chance: 0.2, from: 1.5, to: 2 },
    { chance: 0.1, from: 2, to: 2.25 },
  ],
  /** From this skin tone on (index in SKIN_TONES, 0 = lightest), eyes are brown most of the time. */
  darkSkinFrom: 5,
  brownEyes: 0.9,
};

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const chance = (p: number) => Math.random() < p;
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

/** A Distinctiveness from CHARACTER.distinctiveness (bands by chance, uniform inside a band, two decimals). */
function rollDistinctiveness(): number {
  const bands = CHARACTER.distinctiveness;
  let r = Math.random() * bands.reduce((sum, b) => sum + b.chance, 0);
  const band = bands.find((b) => (r -= b.chance) < 0) ?? bands[0];
  return Math.round(rand(band.from, band.to) * 100) / 100;
}

/** Weighted pick from { id: weight }. */
function pickWeighted(weights: Record<string, number>): string {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [id, w] of entries) if ((r -= w) < 0) return id;
  return entries[entries.length - 1][0];
}

/** Any style of an add-on category except "none". */
const anyStyle = (category: AddonCategory) => pick(addonStyles(category)).id;

/** Everything worn or coloured: what `transition` blends and swaps in. */
type Style = {
  skin: SkinToneId;
  eyes: EyeColourId;
  hair: HairStyle;
  hairColour: HairColourId;
  addons: Record<AddonCategory, AddonStyle>;
  facialHairColour: FacialHairColour;
};

// One transition at a time: a newer click supersedes an older one that is still downloading.
let run = 0;

/** The last transition, fully landed: the morph finished and the pieces faded (see characterSettled). */
let settled: Promise<void> = Promise.resolve();

/**
 * Resolves once the last Random character / Reset has fully landed: the face morph has finished and the hair and add-ons
 * have cross-faded. The voice screenshot waits for it (VoicePanel): mid-change, the two-render fade isn't in a single
 * render, and the face would be half-morphed. Waits again if a newer change starts meanwhile.
 */
export async function characterSettled(): Promise<void> {
  for (let current = settled; ; current = settled) {
    await current;
    if (current === settled) return;
  }
}

/** Start a transition and remember when it has fully landed. A failed change has landed too (what made it on stays). */
function track(change: Promise<void>): Promise<void> {
  const landed = change.catch((err: unknown) => console.warn("[character] change failed:", err));
  settled = Promise.all([landed, wait(CHARACTER.duration)]).then(() => {});
  return landed;
}

/**
 * Run `motion` (the face morph, emotion, pose) with the colours blending, and cross-fade the hair and add-ons
 * CHARACTER.styleAt seconds later. Resolves when that fade has finished (the Toolbar keeps its buttons disabled until then).
 */
async function transition(style: Style, motion: () => void): Promise<void> {
  const id = ++run;
  // 1. Morph now, the skin and eye colours blending along with it, and download what the new style needs meanwhile
  //    (already-attached pieces need nothing).
  motion();
  setSkinTone(style.skin, CHARACTER.duration);
  setEyeColour(style.eyes, CHARACTER.duration);
  setHairColour(style.hairColour, CHARACTER.duration); // on the old hair, brows, lashes and beard; the new ones wear it
  if (addonState.facialHairColour !== style.facialHairColour) setFacialHairColour(style.facialHairColour, CHARACTER.duration);
  const urls: string[] = [];
  const hair = style.hair === "none" || style.hair === hairState.style ? undefined : hairStyleById(style.hair);
  if (hair) urls.push(hairFileUrl(hair)); // where the hair loader fetches it (production: Vercel Blob)
  for (const c of ADDON_CATEGORIES) {
    const chosen = style.addons[c];
    const def = chosen === "none" || chosen === addonState[c] ? undefined : addonStyleById(c, chosen);
    if (def) urls.push(MODELS_BASE + def.file);
  }
  const downloads = urls.length ? within(Promise.all(urls.map(preload)), CHARACTER.maxDownload) : undefined;
  await Promise.all([downloads, wait(CHARACTER.styleAt)]);
  if (id !== run) return;

  // 2. Cross-fade what changes: the new pieces go on hidden (the batch), then fade in together. Re-applying an
  //    unchanged piece would re-tint it at once and cut its colour blend short, so those are left alone.
  openPieceFade();
  try {
    const attached = [
      style.hair !== hairState.style && setHairStyle(style.hair, true),
      ...ADDON_CATEGORIES.map((c) => style.addons[c] !== addonState[c] && setAddonStyle(c, style.addons[c], true)),
    ];
    await within(Promise.all(attached), CHARACTER.maxAttach);
    await within(precompile(pieceFade.arriving), CHARACTER.maxAttach); // their shaders, off the main thread, before the first frame
    if (id !== run) return finishPieceFade();
    await runPieceFade(CHARACTER.styleFade);
  } catch (err) {
    if (id === run) finishPieceFade(); // never leave the batch open: later swaps would wait for a fade that never runs
    throw err;
  }
}

const wait = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

const within = (work: Promise<unknown>, seconds: number) => Promise.race([work, wait(seconds)]);

export function randomCharacter(): Promise<void> {
  const age = rand(...CHARACTER.age);
  const old = age >= CHARACTER.old;

  // Colouring: eye colour leans on skin tone.
  const tone = Math.floor(Math.random() * SKIN_TONES.length);
  const browns = EYE_COLOURS.filter((c) => c.id.includes("brown"));
  const eyes = (tone >= CHARACTER.darkSkinFrom && chance(CHARACTER.brownEyes) ? pick(browns) : pick(EYE_COLOURS)).id;

  // Hair: sometimes none, greyer with age.
  const hair = chance(old ? CHARACTER.baldWhenOld : CHARACTER.bald) ? "none" : pick(HAIR_STYLES).id;
  const grey = old && chance(CHARACTER.greyWhenOld);
  const colour = grey ? pick(["grey", "white"]) : pickWeighted(CHARACTER.hairColours);

  // Brows and lashes always; beard and glasses by chance. The beard wears the hair colour.
  const style: Style = {
    skin: SKIN_TONES[tone].id,
    eyes,
    hair,
    hairColour: (HAIR_COLOURS.find((c) => c.id === colour) ?? NATURAL_HAIR).id,
    addons: {
      eyebrows: anyStyle("eyebrows"),
      eyelashes: anyStyle("eyelashes"),
      facialHair: chance(CHARACTER.facialHair) ? anyStyle("facialHair") : "none",
      glasses: chance(CHARACTER.glasses) ? anyStyle("glasses") : "none",
    },
    facialHairColour: "hair",
  };

  // Expression.
  const weights = Object.fromEntries([NEUTRAL, ...emotionDefs.map((e) => e.id)].map((id) => [id, CHARACTER.emotions[id] ?? 1]));
  const emotion = pickWeighted(weights);
  const intensity = Math.round(rand(...CHARACTER.intensity) * 100) / 100;
  const distinctiveness = rollDistinctiveness();

  return track(transition(style, () => {
    // Face and age: one tween, so the shape and the skin's ageing move together.
    // (the Age is fitted with the face: an age set afterwards could break a face that only fits at rest)
    morphs.tweenTo(randomFace(visibleSliders(), distinctiveness, { [AGE.target]: age }), CHARACTER.duration);
    setEmotion(emotion, CHARACTER.duration); // the expression on the face's clock, not the emotion buttons' quicker blend
    setIntensity(intensity, "code", CHARACTER.duration);
  }));
}

/**
 * Reset: a first visit, i.e. a blank head. The face (every slider, Age, fine-tune) at rest, default skin and eyes,
 * no hair, brows, lashes, beard or glasses (HAIR_DEFAULTS / ADDON_DEFAULTS), no emotion at the default intensity,
 * and a centred pose. "Look at cursor" is a device preference and stays. Same two steps as Random character.
 */
export function resetCharacter(): Promise<void> {
  const { facialHairColour, ...addons } = ADDON_DEFAULTS;
  const style: Style = { skin: SKIN_DEFAULT, eyes: EYE_DEFAULT, hair: HAIR_DEFAULTS.style, hairColour: HAIR_DEFAULTS.colour, addons, facialHairColour };
  return track(transition(style, () => {
    morphs.reset(CHARACTER.duration);
    clearRandomFace();
    setEmotion(NEUTRAL, CHARACTER.duration);
    setIntensity(sliders.emotions.intensity.default, "code", CHARACTER.duration);
    centrePose(CHARACTER.duration);
  }));
}
