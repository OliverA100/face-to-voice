/**
 * A character as data: character.json in the export, and what a rebuild link carries (/#c=<base64url JSON>).
 * Pure: no app state here, so the link can be opened before anything else loads (lib/export/openLink.ts) and the
 * round trip is unit-tested. lib/export/character.ts reads the live character into this shape.
 *
 * Values are as the app stores them: `shape` is morph target → slider value (only what differs from the default),
 * `pose` is degrees, the rest are ids from the app's own lists. Opening a link writes it into the same sessionStorage
 * keys a reload reads, so the app's usual restore code checks every value (unknown ids and targets are ignored,
 * numbers clamped to their ranges).
 */

export const CHARACTER_FORMAT = "face-to-voice/character";
export const CHARACTER_VERSION = 1;

export interface CharacterFile {
  format: typeof CHARACTER_FORMAT;
  version: number;
  sliders: number; // data/sliders.json version the shape was made with
  shape: Record<string, number>;
  emotion: string;
  intensity: number;
  pose: Record<string, number>; // headYaw, headPitch, headRoll, gazeYaw, gazePitch (degrees)
  hair: { style: string; colour: string };
  addons: Record<string, string>; // eyebrows, eyelashes, facialHair, glasses, facialHairColour
  skin: string;
  eyes: string;
}

/** Longest link payload we'll read: a full random face is ~1.5 KB, so anything far larger isn't ours. */
const MAX_CODE = 16_000;

export function encodeCharacter(c: CharacterFile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The character in a link code, or null if it isn't one (wrong format, a newer version, or malformed). */
export function decodeCharacter(code: string): CharacterFile | null {
  if (!code || code.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  try {
    const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as CharacterFile;
    if (c?.format !== CHARACTER_FORMAT || typeof c.version !== "number" || c.version > CHARACTER_VERSION) return null;
    const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!isObject(c.shape) || !isObject(c.pose) || !isObject(c.hair) || !isObject(c.addons)) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * The sessionStorage entries a reload reads (keys and shapes as in lib/faceSession.ts, pose.ts, hair.ts, addons.ts,
 * skin.ts and eyes.ts). Each module validates its own entry when it restores.
 */
export function storageEntries(c: CharacterFile): Record<string, string> {
  return {
    "ftv-face": JSON.stringify({ shape: c.shape, emotion: c.emotion, intensity: c.intensity }),
    "ftv-pose": JSON.stringify(c.pose),
    "ftv-hair": JSON.stringify(c.hair),
    "ftv-addons": JSON.stringify(c.addons),
    "ftv-skin": String(c.skin),
    "ftv-eyes": String(c.eyes),
  };
}
