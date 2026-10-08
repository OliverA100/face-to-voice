/**
 * The face in words, for screen readers: the 3D head's text alternative (components/scene/FaceCanvas.tsx) and what
 * Random character / Reset announce (components/ui/Toolbar.tsx). Built from currentLook(), the look the voice hears
 * (what is ON the head, so a style still loading is not described yet), with the panel's own labels.
 *
 *   "3D head: tan skin, hazel eyes, auburn hair (blunt bob with bangs), natural eyebrows, goatee, round wire glasses.
 *    Older. Happy, strong. Head turned 20° right."
 */
import { ADDON_CATEGORIES, ADDONS, addonStyleById } from "@/lib/addons";
import { AGE } from "@/lib/age";
import { emotionDefs, sliders } from "@/lib/data";
import { hairStyleById } from "@/lib/hair";
import { currentLook } from "@/lib/look";
import { morphs } from "@/lib/morphs/store";
import { toUi } from "@/lib/morphs/travel";
import { EYE_COLOURS, HAIR_COLOURS, SKIN_TONES } from "@/lib/swatches";

const lower = (s: string | undefined) => (s ?? "").toLowerCase();
const colourName = (id: string | undefined) => lower(HAIR_COLOURS.find((c) => c.id === id)?.label);
const STRENGTH: Record<string, string> = { "0.25": "slight", "0.5": "moderate", "0.75": "strong", "1": "full" };
const POSE: [key: string, verb: string, pos: string, neg: string][] = [
  ["poseYaw", "turned", "right", "left"],
  ["posePitch", "tipped", "back", "forward"],
  ["poseRoll", "tilted", "right", "left"],
];

export function describeFace(): string {
  const look = currentLook();
  const parts = [`${lower(SKIN_TONES.find((t) => t.id === look.skin)?.label)} skin`, `${lower(EYE_COLOURS.find((c) => c.id === look.eyes)?.label)} eyes`];

  if (look.hair === "none") parts.push("no hair");
  else {
    const colour = look.hairColour === "natural" ? "" : `${colourName(look.hairColour)} `;
    parts.push(`${colour}hair (${lower(hairStyleById(look.hair)?.label)})`);
  }
  for (const c of ADDON_CATEGORIES) {
    const id = look[c];
    if (!id || id === "none") continue;
    const style = lower(addonStyleById(c, id)?.label ?? id);
    // "natural eyebrows", "long eyelashes", "round wire glasses"; beards and shades name themselves ("goatee", "round shades")
    const noun = c === "facialHair" || /shades/.test(style) ? "" : ` ${lower(ADDONS[c].label)}`;
    const own = c === "facialHair" && look.facialHairColour ? `${colourName(look.facialHairColour)} ` : "";
    parts.push(`${own}${style}${noun}`);
  }
  const sentences = [`3D head: ${parts.join(", ")}.`];

  const ageDef = sliders.sliders.find((s) => s.target === AGE.target);
  const age = ageDef ? toUi(ageDef, morphs.base[AGE.target] ?? ageDef.default) : 0;
  if (Math.abs(age) > 0.25) sentences.push(`${Math.abs(age) > 0.7 ? "Much " : ""}${age > 0 ? "older" : "younger"}.`.replace(/^./, (c) => c.toUpperCase()));

  if (look.emotion) {
    const name = emotionDefs.find((e) => e.id === look.emotion)?.label ?? look.emotion;
    sentences.push(`${name}, ${STRENGTH[look.emotionIntensity] ?? "moderate"}.`);
  }
  const pose = POSE.filter(([k]) => look[k]).map(([k, verb, pos, neg]) => `${verb} ${Math.abs(Number(look[k]))}° ${Number(look[k]) > 0 ? pos : neg}`);
  if (pose.length) sentences.push(`Head ${pose.join(", ")}.`);
  return sentences.join(" ");
}
