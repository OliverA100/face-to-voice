/**
 * Everything the visitor styled besides the sliders. It is sent with the face so the voice
 * reflects the whole look: skin tone, hair and every add-on ("none" when off).
 * Values are short ids; the server turns them into words (lib/server/look.ts).
 *
 * Styles are read from what is ON THE HEAD (the attached meshes), not from what was last clicked:
 * a style that is still loading is not in the screenshot yet, and picture, words and cache key
 * must agree. Colours apply at once, so they come from the state.
 */
import { ADDON_CATEGORIES, addonRig, addonState } from "@/lib/addons";
import { hairRig, hairState } from "@/lib/hair";
import { currentEmotion, NEUTRAL } from "@/lib/emotion";
import { eyeState } from "@/lib/eyes";
import { currentPose } from "@/lib/pose";
import { skinState } from "@/lib/skin";

const attached = (node: { visible: boolean; userData: Record<string, unknown> } | null): string => (node?.visible ? ((node.userData.style as string | undefined) ?? "none") : "none");

/** `withCursor` false: the head pose without what following the cursor adds (lib/pose.ts currentPose). */
export function currentLook(withCursor = true): Record<string, string> {
  const look: Record<string, string> = { skin: skinState.tone, eyes: eyeState.colour, hair: attached(hairRig.mesh), hairColour: hairState.colour };
  for (const c of ADDON_CATEGORIES) look[c] = attached(addonRig.meshes[c]);
  // Only said when there is a beard with a colour of its own that differs from the hair's. Its own
  // Natural always counts: those are the beard's painted colours, not the hair's.
  const own = addonState.facialHairColour;
  if (look.facialHair !== "none" && own !== "hair" && (own !== hairState.colour || own === "natural")) look.facialHairColour = own;
  // The expression is on the face in the screenshot too (quarter steps, so the cache key is stable).
  const { emotion, intensity } = currentEmotion();
  if (emotion !== NEUTRAL && intensity > 0) {
    look.emotion = emotion;
    look.emotionIntensity = String(intensity);
  }
  // The head pose shows in the screenshot too: rounded to 10° (look-at-cursor moves it, so the steps keep the
  // cache key from changing on every pixel). Straight ahead is left out.
  const pose = currentPose(withCursor);
  const tens = (v: number) => Math.round(v / 10) * 10;
  for (const [key, v] of [["poseYaw", pose.headYaw], ["posePitch", pose.headPitch], ["poseRoll", pose.headRoll]] as const) {
    if (tens(v) !== 0) look[key] = String(tens(v));
  }
  return look;
}
