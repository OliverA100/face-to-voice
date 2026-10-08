/**
 * The face → voice flow, shared by the route handlers.
 *
 *   face (sliders + screenshot) --Claude--> description fields --template--> ElevenLabs prompt
 *     faceKey + visitor cache the fields      descKey caches previews + the saved voice (shared by all visitors)
 */
import "server-only";

import { summariseSliders } from "@/lib/voice/sliderSummary";

import { describeFace } from "./claude";
import { acquireLock, cacheDel, cacheGet, cacheSet, poolEvictions, poolList, poolRefresh, poolRemove, poolTouch, releaseLock, storeAudio } from "./cache";
import { createVoice, deleteVoice, designVoice, listAppVoices, subscription, UpstreamError, type DesignSettings } from "./elevenlabs";
import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";
import { descriptionKey, faceKey } from "./keys";
import { lookText, restingLook, type Look } from "./look";
import { quantiseIntensity } from "./emotion";
import { AGE_RANGES, buildVoiceDescription, descriptionIdentity, expressionLine, previewText, type DescriptionFields, type Presentation } from "./prompt";
import { consumeDailyCap, refundDailyCap } from "./ratelimit";

export interface PreviewRecord {
  generatedVoiceId: string;
  url: string;
  durationSecs: number;
}

export interface VoiceRecord {
  descKey: string;
  description: string; // the ElevenLabs prompt
  previews: PreviewRecord[];
  seed: number;
  cast: Pick<DescriptionFields, "presentation" | "ageRange">; // picks the closest studio voice
  design: DesignSettings & { text: string }; // what Voice Design was asked
  /** A saved voice per preview take, so a face can switch to another of its three voices without changing the one
   *  other faces with this description use. Empty until a preview is chosen. */
  takes: Record<number, Take>;
  // The take chosen last, mirrored from `takes` (voiceId is null until a preview is chosen, or after its voice was evicted).
  voiceId: string | null;
  studioFallback?: boolean;
  chosenIndex?: number; // set together with voiceId
  createdAt: number;
}

type Take = { voiceId: string; studioFallback?: boolean };

/** The voice to speak with: the take asked for, or the record's latest one when no take is given. */
export function takeVoice(record: VoiceRecord, take?: number): string | null {
  return take === undefined ? record.voiceId : (record.takes[take]?.voiceId ?? null);
}

/** Pool entries are per take: "<descKey>#<take>". */
const poolKey = (descKey: string, take: number) => `${descKey}#${take}`;

/** Everything sent to Voice Design for this voice, for the export. Re-running it gives a similar voice, not the same one. */
export interface VoiceRecipe extends DesignSettings {
  voiceDescription: string;
  text: string;
  seed: number;
}

export interface DesignResult {
  faceKey: string;
  descKey: string;
  fields: DescriptionFields;
  presentation: Presentation;
  description: string;
  previews: PreviewRecord[];
  voiceId: string | null;
  chosenIndex: number | null; // which preview voiceId was saved from, when voiceId is set
  savedTakes: number[]; // the previews that already have a saved voice (choosing them again is free)
  studioFallback: boolean; // voiceId is a studio stand-in, not one of these previews
  recipe: VoiceRecipe;
  cached: { description: boolean; previews: boolean };
}

/*
 * Everything derived from Claude's reading of the screenshot is kept per visitor. The screenshot is not in the face
 * key and cannot be: the same look renders to different JPEGs (idle motion, viewport, GPU backend; measured: three
 * page loads of one look gave three different hashes), so a crafted image sent by a script must never reach another
 * visitor through a shared casting. The voice records (descKey) stay shared: they are keyed by the validated fields.
 */
const faceCacheKey = (visitor: string, k: string) => `ftv:face:${visitor}:${k}`;
const descCacheKey = (k: string) => `ftv:desc:${k}`;
const accentCacheKey = (visitor: string, k: string) => `ftv:accent:${visitor}:${k}`;

/** The design route's time (its maxDuration is 120 s): Voice Design gets what Claude left, so it never outlives the function. */
export const DESIGN_BUDGET_MS = 110_000;
/** How long a request waits for another one doing the same paid job (a design, a save) before saying "busy". */
const WAIT_MS = 30_000;

/** Polls `get` every second until it gives something, or `ms` have passed (null). */
async function waitFor<T>(get: () => Promise<T | null>, ms: number): Promise<T | null> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 1000));
    const v = await get();
    if (v) return v;
  }
  return null;
}

export async function designForFace(input: {
  weights: Record<string, number>;
  imageJpegBase64: string;
  look: Look;
  visitor: string; // ratelimit.ts visitorId: scopes the casting caches
  deadline?: number; // Date.now() by which the request must be answered (default: DESIGN_BUDGET_MS from now)
}): Promise<DesignResult> {
  const deadline = input.deadline ?? Date.now() + DESIGN_BUDGET_MS;
  const left = () => deadline - Date.now();
  // 1. Description (cached per visitor, quantised face and look: what is in the picture is in the key). The gender is read from the look too.
  const fKey = faceKey(input.weights, input.look);
  let fields = await cacheGet<DescriptionFields>(faceCacheKey(input.visitor, fKey));
  const descriptionCached = !!fields;
  if (!fields) {
    // The expression is the emotion the voice is designed in; it comes from the validated look, not from Claude.
    const emotion = input.look.emotion ?? "neutral";
    const emotionIntensity = quantiseIntensity(Number(input.look.emotionIntensity ?? 0));
    // The face at rest (no expression, no pose) keeps the accent it was first cast with: Claude's three accents vary per call.
    const restKey = faceKey(input.weights, restingLook(input.look));
    const keptAccent = await cacheGet<string>(accentCacheKey(input.visitor, restKey));
    await consumeDailyCap("castings"); // Claude is paid per call: a global cap, on top of the visitor's own limit
    let r;
    try {
      r = await describeFace({
        imageJpegBase64: input.imageJpegBase64,
        sliderSummary: summariseSliders(input.weights),
        ageSlider: input.weights.sem_age,
        expression: expressionLine(emotion, emotionIntensity),
        look: lookText(input.look),
        pickKey: restKey,
        lookIds: input.look,
      });
    } catch (e) {
      await refundDailyCap("castings", 1);
      throw e;
    }
    if (keptAccent) r.fields.accent = keptAccent;
    else await cacheSet(accentCacheKey(input.visitor, restKey), r.fields.accent);
    fields = { ...r.fields, emotion, emotionIntensity };
    if (r.replaced.length) console.warn(`[voice] replaced free text that hit the policy: ${r.replaced.join(", ")}`);
    await cacheSet(faceCacheKey(input.visitor, fKey), fields);
  }

  // 2. Previews + voice (cached per normalised description).
  const dKey = descriptionKey(descriptionIdentity(fields));
  let record = await cacheGet<VoiceRecord>(descCacheKey(dKey));
  const previewsCached = !!record;
  // One request designs a description at a time; another visitor cast the same way meanwhile waits for its record.
  const lock = `ftv:lock:design:${dKey}`;
  if (!record) {
    const token = await acquireLock(lock, Math.ceil(DESIGN_BUDGET_MS / 1000));
    if (!token) {
      record = await waitFor(() => cacheGet<VoiceRecord>(descCacheKey(dKey)), Math.min(WAIT_MS, left() - 5_000));
      if (!record) throw new ApiError("busy", MESSAGES.busy, 409);
    } else {
      try {
        record = (await cacheGet<VoiceRecord>(descCacheKey(dKey))) ?? (await designRecord(dKey, fields, left));
      } finally {
        await releaseLock(lock, token);
      }
    }
  }
  const chosenIndex = record.voiceId ? (record.chosenIndex ?? null) : null;
  if (record.voiceId && chosenIndex !== null && !record.studioFallback) await poolTouch(poolKey(dKey, chosenIndex), record.voiceId);

  return {
    faceKey: fKey,
    descKey: dKey,
    fields,
    presentation: fields.presentation,
    description: record.description,
    previews: record.previews,
    voiceId: record.voiceId,
    chosenIndex,
    savedTakes: Object.keys(record.takes).map(Number),
    studioFallback: !!(record.voiceId && record.studioFallback),
    recipe: voiceRecipe(record),
    cached: { description: descriptionCached, previews: previewsCached },
  };
}

/** Voice Design for a description no record has yet (charged once for three samples), stored as its record. */
async function designRecord(dKey: string, fields: DescriptionFields, left: () => number): Promise<VoiceRecord> {
  await consumeDailyCap("designs");
  let description = buildVoiceDescription(fields);
  const seed = parseInt(dKey.slice(0, 8), 16) % 2147483647;
  const text = previewText(fields);
  // what the request has left, less a moment to store the previews
  const timeout = () => Math.max(5_000, left() - 5_000);
  let designed;
  try {
    try {
      designed = await designVoice(description, text, seed, timeout());
    } catch (e) {
      // If ElevenLabs turns the prompt down, try once more without the ethnicity words. Only a refusal: after a timeout
      // or an outage the second call would fail the same way (and a timed-out one may still have been billed).
      const plain = buildVoiceDescription(fields, { ethnicity: false });
      const refused = e instanceof UpstreamError && e.upstreamStatus >= 400 && e.upstreamStatus < 500 && e.upstreamStatus !== 429;
      if (plain === description || !refused || left() < 20_000) throw e;
      console.warn("[voice] design failed with the ethnicity label; retrying without it");
      description = plain;
      designed = await designVoice(description, text, seed, timeout());
    }
  } catch (e) {
    await refundDailyCap("designs", 1); // nothing was designed
    throw e;
  }
  const stored: PreviewRecord[] = [];
  for (const [i, p] of designed.previews.entries()) {
    const ext = p.mediaType.includes("wav") ? "wav" : "mp3";
    // Named after the take itself: stored files are never overwritten (cache.ts storeAudio), so a path shared with an
    // earlier design of this description (after its record expired) would play that design's audio for this voice.
    const url = await storeAudio(`voices/${dKey}/${i}-${p.generatedVoiceId.replace(/[^A-Za-z0-9_-]/g, "")}.${ext}`, p.audio, p.mediaType);
    stored.push({ generatedVoiceId: p.generatedVoiceId, url, durationSecs: p.durationSecs });
  }
  // The line is stored as sent: everyday faces share this record, and their own lines differ.
  const record: VoiceRecord = { descKey: dKey, description, previews: stored, seed, cast: { presentation: fields.presentation, ageRange: fields.ageRange }, design: { ...designed.settings, text }, takes: {}, voiceId: null, createdAt: Date.now() };
  await cacheSet(descCacheKey(dKey), record);
  return record;
}

/** The Voice Design request behind a record. */
function voiceRecipe(record: VoiceRecord): VoiceRecipe {
  return { ...record.design, voiceDescription: record.description, seed: record.seed };
}

export interface SelectResult {
  voiceId: string;
  saved: boolean; // false when a studio fallback voice was used
  chosenIndex?: number; // the preview the voice came from (another visitor's pick if they saved this voice first)
  message?: string;
}

export interface SelectOptions {
  /** The preview the visitor heard: refused when the record was designed again since (another visitor, an expiry). */
  generatedVoiceId?: string;
  /** The visitor's limit on new voices (ratelimit "select"), called only when this choice saves one: going back to a
   *  take that is already saved is free. */
  chargeVisitor?: () => Promise<void>;
}

/** What the voice panel says when its previews can't become a voice any more; "Find a new voice" designs fresh ones. */
const EXPIRED = {
  gone: "These voices have expired. Find the voice again to hear new ones.",
  redesigned: "These voices were just designed again. Find the voice again to hear the new ones.",
};

/**
 * Turn the chosen preview into a usable voice. Each take is saved once and reused after that (switching back is
 * free). Saving costs one slot and one monthly add/edit operation, so it is capped per day and by the plan's
 * remaining operations; when the cap is hit, the closest pre-designed studio voice is returned instead.
 */
export async function selectPreview(descKey: string, previewIndex: number, opts: SelectOptions = {}): Promise<SelectResult> {
  const record = await cacheGet<VoiceRecord>(descCacheKey(descKey));
  if (!record) throw new ApiError("expired", EXPIRED.gone, 410);
  const preview = record.previews[previewIndex];
  if (!preview) throw new ApiError("bad_request", "Unknown preview.", 400);
  if (opts.generatedVoiceId && opts.generatedVoiceId !== preview.generatedVoiceId) throw new ApiError("expired", EXPIRED.redesigned, 409);
  if (record.takes[previewIndex]) return chooseSavedTake(record, previewIndex);

  await opts.chargeVisitor?.();
  // One request saves a take at a time: a second one (another visitor, a double click) waits for that voice instead of
  // saving a second copy of it (a slot and an add/edit each, and one of the two would be orphaned).
  const lock = `ftv:lock:save:${descKey}#${previewIndex}`;
  const token = await acquireLock(lock, 60);
  if (!token) {
    const saved = await waitFor(async () => {
      const r = await cacheGet<VoiceRecord>(descCacheKey(descKey));
      return r?.takes[previewIndex] ? r : null;
    }, WAIT_MS);
    if (!saved) throw new ApiError("busy", MESSAGES.busy, 409);
    return chooseSavedTake(saved, previewIndex);
  }
  try {
    const now = (await cacheGet<VoiceRecord>(descCacheKey(descKey))) ?? record; // it may have been saved meanwhile
    return now.takes[previewIndex] ? await chooseSavedTake(now, previewIndex) : await saveTake(now, previewIndex);
  } finally {
    await releaseLock(lock, token);
  }
}

/** A take that already has its voice: it becomes the record's latest choice (free). */
async function chooseSavedTake(record: VoiceRecord, previewIndex: number): Promise<SelectResult> {
  const have = record.takes[previewIndex];
  if (!have.studioFallback) await poolTouch(poolKey(record.descKey, previewIndex), have.voiceId);
  await cacheSet(descCacheKey(record.descKey), { ...record, voiceId: have.voiceId, studioFallback: have.studioFallback, chosenIndex: previewIndex });
  return { voiceId: have.voiceId, saved: !have.studioFallback, chosenIndex: previewIndex, message: have.studioFallback ? MESSAGES.voice_quota : undefined };
}

/** Save a take as a voice (or hand out a studio stand-in when the quota says no). */
async function saveTake(record: VoiceRecord, previewIndex: number): Promise<SelectResult> {
  const descKey = record.descKey;
  const preview = record.previews[previewIndex];
  const takes = { ...record.takes };
  // Plan quota (when the key can read it): stop before the monthly add/edit budget runs dry.
  // Slots about to be freed by the pool evictions below count as free.
  const evictions = await poolEvictions();
  let sub = await subscription();
  const slotsFull = () => !!sub && sub.voiceSlotsUsed - evictions.length >= sub.voiceLimit;
  if (slotsFull() && (await deleteForgottenVoice())) sub = await subscription();
  const opsLeft = sub ? sub.maxVoiceAddEdits - sub.voiceAddEditCounter > 1 : true;
  let blocked: "month" | "slots" | "day" | null = !opsLeft ? "month" : slotsFull() ? "slots" : null;
  if (!blocked) {
    try {
      await consumeDailyCap("saves");
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "daily_cap") throw e;
      blocked = "day";
    }
  }
  if (blocked) {
    const voiceId = closestStudioVoice(record.cast, descKey);
    if (!voiceId) throw new ApiError("voice_quota", NO_STUDIO[blocked], 429);
    takes[previewIndex] = { voiceId, studioFallback: true };
    await cacheSet(descCacheKey(descKey), { ...record, takes, voiceId, studioFallback: true, chosenIndex: previewIndex });
    return { voiceId, saved: false, chosenIndex: previewIndex, message: MESSAGES.voice_quota };
  }

  // Make room in the pool first, then save.
  for (const old of evictions) {
    await deleteVoice(old.voiceId);
    await poolRemove(old.voiceId);
    await forgetVoice(old.descKey.split("#")[0], old.voiceId);
  }
  let voiceId: string;
  try {
    voiceId = await createVoice(`face-to-voice ${descKey.slice(0, 8)} ${previewIndex + 1}`, record.description, preview.generatedVoiceId);
  } catch (e) {
    await refundDailyCap("saves", 1); // nothing was saved
    if (e instanceof UpstreamError && (e.upstreamStatus === 404 || /not_found|expired/i.test(e.upstreamCode))) {
      // ElevenLabs no longer has these previews: the record can't give a voice any more, so the next design starts afresh
      console.warn("[voice] the previews expired upstream; dropping their record");
      await cacheDel(descCacheKey(descKey));
      throw new ApiError("expired", EXPIRED.gone, 410);
    }
    throw e;
  }
  // Re-read: an eviction above may have been another take of this same record.
  const fresh = (await cacheGet<VoiceRecord>(descCacheKey(descKey))) ?? record;
  const freshTakes = { ...fresh.takes, [previewIndex]: { voiceId } };
  await cacheSet(descCacheKey(descKey), { ...fresh, takes: freshTakes, voiceId, studioFallback: false, chosenIndex: previewIndex });
  await poolTouch(poolKey(descKey, previewIndex), voiceId);
  return { voiceId, saved: true, chosenIndex: previewIndex };
}

/** A voice is gone (evicted, or deleted upstream): every take of this record that used it forgets it. */
async function forgetVoice(descKey: string, voiceId: string): Promise<void> {
  const record = await cacheGet<VoiceRecord>(descCacheKey(descKey));
  if (!record) return;
  const takes = Object.fromEntries(Object.entries(record.takes).filter(([, t]) => t.voiceId !== voiceId));
  await cacheSet(descCacheKey(descKey), { ...record, takes, voiceId: record.voiceId === voiceId ? null : record.voiceId });
}

/** The speak route used this record's take: its voice moves to the back of the pool's eviction queue. */
export async function voiceSpoken(record: VoiceRecord, take: number | undefined, voiceId: string): Promise<void> {
  const index = take ?? record.chosenIndex;
  const t = index === undefined ? undefined : record.takes[index];
  if (t && !t.studioFallback && t.voiceId === voiceId) await poolRefresh(poolKey(record.descKey, index!), voiceId);
}

/** ElevenLabs no longer has this voice (deleted outside the pool): drop it, so choosing the take again saves a new one. */
export async function voiceGone(descKey: string, voiceId: string): Promise<void> {
  console.warn("[voice] a saved voice is gone upstream; forgetting it");
  await poolRemove(voiceId);
  await forgetVoice(descKey, voiceId);
}

const NO_STUDIO = {
  day: "Today's new voices are used up, and no studio voices are configured yet. Try again tomorrow.",
  month: "This month's new voices are used up, and no studio voices are configured yet.",
  slots: "There's no room for a new voice right now, and no studio voices are configured yet.",
};

/**
 * The studio voice nearest the cast: same gender first (a neutral cast fits either), then the nearest age.
 * Ties and bare ids (no "presentation-age" slot) are settled by the description hash.
 */
export function closestStudioVoice(cast: VoiceRecord["cast"], descKey: string): string | null {
  const studio = env.studioVoices;
  if (!studio.length) return null;
  const cost = ({ slot }: { slot: string }) => {
    if (!slot) return 100;
    const [presentation, ...age] = slot.split("-");
    const ageIndex = AGE_RANGES.indexOf(age.join("-") as (typeof AGE_RANGES)[number]);
    if (ageIndex < 0) return 100;
    const gender = presentation === cast.presentation ? 0 : cast.presentation === "neutral" ? 1 : 10;
    return gender + Math.abs(ageIndex - AGE_RANGES.indexOf(cast.ageRange));
  };
  const best = Math.min(...studio.map(cost));
  const tied = studio.filter((v) => cost(v) === best);
  return tied[parseInt(descKey.slice(0, 6), 16) % tied.length].voiceId;
}

/**
 * Delete the oldest app voice that neither the pool nor STUDIO_VOICE_IDS knows about, so it can
 * never fill the slots for good. Such voices are left behind when the pool is lost (every dev
 * restart without Redis). Voices under 10 minutes old are skipped: a parallel save may not have
 * reached the pool yet.
 */
async function deleteForgottenVoice(): Promise<boolean> {
  const known = new Set([...(await poolList()).map((e) => e.voiceId), ...env.studioVoices.map((v) => v.voiceId)]);
  const forgotten = (await listAppVoices()).find((v) => !known.has(v.voiceId) && Date.now() - v.createdAt > 10 * 60_000);
  if (!forgotten) return false;
  console.warn("[voice] slots full; deleting an app voice the pool had forgotten");
  await deleteVoice(forgotten.voiceId);
  return true;
}

/** The record behind a design, for the speak route. */
export async function voiceRecord(descKey: string): Promise<VoiceRecord | null> {
  return cacheGet<VoiceRecord>(descCacheKey(descKey));
}
