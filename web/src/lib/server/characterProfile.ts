/**
 * Character profiles, cached like voices.
 *
 *   casting (this visitor's, for this face) ──Claude──► profile ──► ftv:profile:<profileKey>             shared: one voice, one character
 *   "Recast" ──────────────────────────────────────────────────► ftv:profile:<visitor>:<profileKey>   this visitor's own
 *
 * Reading prefers the visitor's own profile, then the shared one. Only server data reaches the prompt: the cached
 * casting and the look it was made from; the browser only names which face and voice.
 */
import "server-only";

import { acquireLock, cacheGet, cacheSet, releaseLock } from "./cache";
import { ApiError, MESSAGES } from "./errors";
import { descriptionKey, profileKey } from "./keys";
import { lookText } from "./look";
import type { CharacterProfile, ProfileResult } from "@/lib/character/profile";

import { writeProfile } from "./profileClaude";
import { descriptionIdentity, type DescriptionFields } from "./prompt";
import { consumeDailyCap, refundDailyCap } from "./ratelimit";
import { castingFor, castingLook, keepIdentity, waitFor } from "./voice";

export type { ProfileResult };

const sharedKey = (pKey: string) => `ftv:profile:${pKey}`;
const ownKey = (visitor: string, pKey: string) => `ftv:profile:${visitor}:${pKey}`;

/** How long one request may take to write a shared profile, and how long another waits for it (the route has 60 s). */
const WRITE_SECONDS = 55;
const WAIT_MS = 45_000;

/**
 * No casting for this visitor (a new browser or cleared cookie, or it expired): the browser recasts the face for the
 * same voice (POST /api/voice/recast) and asks again, so this is only seen when it can't.
 */
const MISSING = "This character needs casting again. Try again to recast them for the same voice.";

/** The visitor's casting for this face, checked against the voice it was asked for. */
async function castingOf(visitor: string, fKey: string, descKey: string): Promise<DescriptionFields> {
  const fields = await castingFor(visitor, fKey);
  if (!fields) throw new ApiError("recast", MISSING, 410);
  if (descriptionKey(descriptionIdentity(fields)) !== descKey) throw new ApiError("bad_request", MESSAGES.bad_request, 400);
  await keepIdentity(descKey, fields);
  return fields;
}

/** The profile key of a voice and a face (the conversation token route reads the profile with it too). */
export async function profileKeyFor(visitor: string, fKey: string, descKey: string): Promise<{ pKey: string; fields: DescriptionFields }> {
  const fields = await castingOf(visitor, fKey, descKey);
  return { pKey: profileKey(descKey, fields.persona), fields };
}

/** The profile this visitor sees for a voice, or null when none was written yet. */
export async function savedProfile(visitor: string, pKey: string): Promise<ProfileResult | null> {
  const own = await cacheGet<CharacterProfile>(ownKey(visitor, pKey));
  if (own) return { profile: own, own: true };
  const shared = await cacheGet<CharacterProfile>(sharedKey(pKey));
  return shared ? { profile: shared, own: false } : null;
}

/**
 * The character's profile: the saved one, or a new one when there is none or the visitor asks for another
 * (`regenerate`, kept as theirs). Only a new one is charged, to the site-wide daily cap.
 * One request writes a shared profile at a time; another visitor meeting the same character meanwhile gets that one.
 */
export async function profileFor(input: {
  visitor: string;
  faceKey: string;
  descKey: string;
  regenerate: boolean;
  chargeVisitor: () => Promise<void>;
}): Promise<ProfileResult> {
  const { pKey, fields } = await profileKeyFor(input.visitor, input.faceKey, input.descKey);
  const saved = await savedProfile(input.visitor, pKey);
  if (saved && !input.regenerate) return saved;
  const write = async () => {
    await input.chargeVisitor();
    await consumeDailyCap("profiles");
    try {
      // Recast: a different person from the one they have now (profileClaude.ts reimagineBrief)
      const look = lookText(await castingLook(input.visitor, input.faceKey));
      return await writeProfile({ fields, look, previous: input.regenerate ? saved?.profile : undefined });
    } catch (e) {
      await refundDailyCap("profiles", 1);
      throw e;
    }
  };
  if (input.regenerate) {
    const profile = await write();
    await cacheSet(ownKey(input.visitor, pKey), profile);
    return { profile, own: true };
  }
  const lock = `ftv:lock:profile:${pKey}`;
  const token = await acquireLock(lock, WRITE_SECONDS);
  if (!token) {
    const shared = await waitFor(() => cacheGet<CharacterProfile>(sharedKey(pKey)), WAIT_MS);
    if (!shared) throw new ApiError("busy", MESSAGES.busy_profile, 409);
    return { profile: shared, own: false };
  }
  try {
    const shared = await cacheGet<CharacterProfile>(sharedKey(pKey)); // written while this one waited for the lock
    if (shared) return { profile: shared, own: false };
    const profile = await write();
    await cacheSet(sharedKey(pKey), profile);
    return { profile, own: false };
  } finally {
    await releaseLock(lock, token);
  }
}
