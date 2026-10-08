/**
 * The visitor's styling choices (skin tone, eye colour, hair, eyebrows, eyelashes, facial hair, glasses).
 * Everything visible shapes the voice, so the look travels with the face: it is part of the cache
 * key and it is told to Claude in words next to the screenshot.
 *
 * Nothing the browser sends reaches the prompt as text: every key must be one of KEYS and every
 * value one of the ids that key allows (the shipped styles from the index.json files, the swatch
 * ids, "none"). The sentence Claude reads is built here from those ids.
 */
import { z } from "zod";

import eyebrowsIndexJson from "../../../public/models/addons/eyebrows/index.json";
import eyelashesIndexJson from "../../../public/models/addons/eyelashes/index.json";
import facialHairIndexJson from "../../../public/models/addons/facialHair/index.json";
import glassesIndexJson from "../../../public/models/addons/glasses/index.json";
import hairIndexJson from "../../../public/models/hair/index.json";
import { EYE_COLOURS, HAIR_COLOURS, SKIN_TONES } from "../swatches";
import { EMOTION_IDS, emotionWords } from "./emotion";

type Index = { styles: { id: string; label: string }[] };
const styleIds = (index: unknown) => ["none", ...(index as Index).styles.map((s) => s.id)];
const colourIds = HAIR_COLOURS.map((c) => c.id as string);

/** key → how it is named in the sentence, and the values it accepts. */
const KEYS: Record<string, { name: string; values: ReadonlySet<string> }> = {
  skin: { name: "skin tone", values: new Set(SKIN_TONES.map((t) => t.id as string)) },
  eyes: { name: "eye colour", values: new Set(EYE_COLOURS.map((c) => c.id as string)) },
  hair: { name: "hair style", values: new Set(styleIds(hairIndexJson)) },
  hairColour: { name: "hair colour", values: new Set(colourIds) },
  eyebrows: { name: "eyebrows", values: new Set(styleIds(eyebrowsIndexJson)) },
  eyelashes: { name: "eyelashes", values: new Set(styleIds(eyelashesIndexJson)) },
  facialHair: { name: "facial hair", values: new Set(styleIds(facialHairIndexJson)) },
  facialHairColour: { name: "facial hair colour", values: new Set(colourIds) },
  glasses: { name: "glasses", values: new Set(styleIds(glassesIndexJson)) },
  // the expression on the face (the Emotion section); said together as "expression: happy (strong)"
  emotion: { name: "expression", values: new Set(EMOTION_IDS) },
  emotionIntensity: { name: "expression strength", values: new Set(["0.25", "0.5", "0.75", "1"]) },
  // head pose in 10° steps (as seen from the front): + = turned right / bent backward / tilted right
  poseYaw: { name: "head turn", values: new Set(["-40", "-30", "-20", "-10", "10", "20", "30", "40"]) },
  posePitch: { name: "head bend", values: new Set(["-20", "-10", "10", "20"]) },
  poseRoll: { name: "head tilt", values: new Set(["-20", "-10", "10", "20"]) },
};
const EMOTION_KEYS = new Set(["emotion", "emotionIntensity"]);
const POSE_KEYS: [string, string, string][] = [["poseYaw", "right", "left"], ["posePitch", "backward", "forward"], ["poseRoll", "right", "left"]];
const POSE_VERBS: Record<string, string> = { poseYaw: "turned", posePitch: "bent", poseRoll: "tilted" };

export const LookSchema = z.record(z.string(), z.string()).superRefine((look, ctx) => {
  for (const [key, value] of Object.entries(look)) {
    if (!Object.hasOwn(KEYS, key)) ctx.addIssue({ code: "custom", message: "unknown look entry", path: [key] });
    else if (!KEYS[key].values.has(value)) ctx.addIssue({ code: "custom", message: "unknown look value", path: [key] });
  }
});
export type Look = z.infer<typeof LookSchema>;

/** The look without the expression and the head pose: what the character is, not how they look right now. */
export const restingLook = (look: Look): Look =>
  Object.fromEntries(Object.entries(look).filter(([key]) => !EMOTION_KEYS.has(key) && !key.startsWith("pose")));

/**
 * Hair ids are asset names ("short01"), so they are said by their panel label. Add-on and swatch
 * ids are readable as they are ("long-beard", "round-shades", "dark-brown") and only unique
 * inside their category, which the entry's name gives ("eyebrows: natural").
 */
const LABELS: Record<string, Map<string, string>> = {
  hair: new Map((hairIndexJson as Index).styles.map((s) => [s.id, s.label.toLowerCase()])),
};

const words = (id: string) => id.replace(/[_-]+/g, " ").toLowerCase();

/** "hair style: crop; hair colour: natural" (empty string when nothing is styled). Entries that are not in KEYS are left out. */
export function lookText(look: Look): string {
  const parts = Object.keys(look)
    .filter((key) => Object.hasOwn(KEYS, key) && !EMOTION_KEYS.has(key) && !key.startsWith("pose"))
    .sort()
    .map((key) => {
      const value = look[key];
      if (value === "none") return `${KEYS[key].name}: none`;
      return `${KEYS[key].name}: ${LABELS[key]?.get(value) ?? words(value)}`;
    });
  const expression = look.emotion ? emotionWords(look.emotion, Number(look.emotionIntensity ?? "1")) : "";
  if (expression) parts.push(`expression: ${expression}`);
  const pose = POSE_KEYS.filter(([k]) => look[k]).map(([k, pos, neg]) => {
    const v = Number(look[k]);
    return `${POSE_VERBS[k]} ${Math.abs(v)}° ${v > 0 ? pos : neg}`;
  });
  if (pose.length) parts.push(`head pose: ${pose.join(", ")}`);
  return parts.join("; ");
}
