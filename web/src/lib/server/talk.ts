/**
 * Live conversations: the browser asks for a room, the server mints a short-lived LiveKit token that also dispatches the
 * character agent into that room with everything it needs (the voice, the instructions). Nothing the agent trusts comes
 * from the browser: the voice id is read from the voice record, the profile from the cache, and both are signed into
 * the token with the API secret.
 *
 *   POST /api/talk/token ─► invite ─► slot (MAX_CONCURRENT_TALKS at a time) ─► voice + profile ─► AccessToken
 *                                                                                              room:  talk-<uuid>
 *                                                                                              grant: join, mic only, no data
 *                                                                                              roomConfig.agents: ftv-character + metadata
 */
import "server-only";

import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { createHash, timingSafeEqual } from "node:crypto";

import { acquireLock, pinVoice, releaseLock } from "./cache";
import { profileKeyFor, savedProfile } from "./characterProfile";
import { talkMetadata } from "./characterPrompt";
import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";
import { getRedis } from "./ratelimit";
import { closestStudioVoice, takeVoice, voiceRecord, voiceSpoken } from "./voice";
import type { TalkTicket } from "@/lib/talk/ticket";

/** The agent's name: it only joins rooms that dispatch it by name (explicit dispatch). */
const AGENT_NAME = "ftv-character";
/** How long the token may be used to join (the browser joins at once); a reconnect after that is still allowed by
 *  LiveKit. Short: within it the token could create its room again (and dispatch another agent) once the first closed. */
const TOKEN_TTL_SECONDS = 20;
/** A slot outlives the conversation by this much (the agent's goodbye, a slow close); then it frees itself. */
const SLOT_GRACE_SECONDS = 30;
/** A slot whose room LiveKit doesn't know after this long was never joined (or has ended): it is freed. */
const UNJOINED_SECONDS = 45;
/** How long a slot and the voice's pin last: the conversation starts when the visitor joins, up to the token's life
 *  after it was minted, then runs maxSeconds, plus the goodbye and a slow close. */
const holdSeconds = () => env.talk.maxSeconds + TOKEN_TTL_SECONDS + SLOT_GRACE_SECONDS;

export const TALK_MESSAGES = {
  invite: "Talking to characters is invite-only for now.",
  busy: "All the characters are busy talking right now. Try again in a few minutes.",
  alreadyTalking: "You already have a conversation open. End it first, or try again in a minute.",
  noProfile: "Meet the character first.",
  retired: "This voice was removed to make room for newer ones. Choose it again to bring it back.",
};

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Whether `code` opens talking: always once TALK_PUBLIC=1, else one of TALK_INVITE_CODES (constant time, digests of
 *  equal length, so neither the code nor its length leaks). */
export function inviteOk(code: string | undefined): boolean {
  if (talkIsPublic()) return true;
  const given = digest(code ?? "");
  return env.talk.inviteCodes.reduce((ok, c) => timingSafeEqual(digest(c), given) || ok, false);
}

/** Talking is open to everyone (TALK_PUBLIC=1): no invite code is asked for. */
export const talkIsPublic = () => env.talk.public;

export function talkConfigured(): boolean {
  return !!(env.livekit.url && env.livekit.apiKey() && env.livekit.apiSecret());
}

// --- conversations at a time (MAX_CONCURRENT_TALKS) -----------------------------------------------------------------
// A Redis sorted set of "<visitor>|<room>" scored by when the slot expires. A visitor's new conversation replaces their
// own previous one (its room is closed, so the limit still holds). LiveKit is the truth about which rooms still exist:
// when the slots are full, rooms LiveKit no longer has (ended early, or never joined) are freed first.

const SLOTS_KEY = "ftv:talk:slots";
const memSlots = new Map<string, number>(); // "<visitor>|<room>" → expiry (ms)
const roomOf = (member: string) => member.slice(member.indexOf("|") + 1);

/** Slot checks wait for LiveKit under the slots lock: a short timeout and no retries in other regions keep them well
 *  inside the lock (the SDK's defaults, 10 s per request plus failover, could outlast it and let two slots in). */
const LIVEKIT_TIMEOUT_SECONDS = 4;
const SLOTS_LOCK_SECONDS = 30;

function roomService(): RoomServiceClient {
  return new RoomServiceClient(env.livekit.url.replace(/^ws/, "http"), env.livekit.apiKey(), env.livekit.apiSecret(), {
    requestTimeout: LIVEKIT_TIMEOUT_SECONDS,
    failover: false,
  });
}

async function liveRooms(names: string[]): Promise<Set<string>> {
  return new Set((await roomService().listRooms(names)).map((r) => r.name));
}

/**
 * Take a conversation slot for `room`, or throw `busy`. A Redis failure counts as busy (fail closed). Under a lock, so two
 * requests at once can't both see a free slot. `replaces`: the room of this browser's previous conversation ("Have another
 * chat"), ended here if it is this visitor's; not every room of theirs (a browser without cookies is its whole network).
 * `ownBrowser`: the visitor is one browser (a cookie), so it may hold one slot at a time; a network id never is limited
 * this way, or one chat would block everyone behind the same address.
 */
export async function takeSlot(room: string, visitor: string, replaces?: string, ownBrowser = false): Promise<void> {
  const lock = await acquireLock("ftv:lock:talk-slots", SLOTS_LOCK_SECONDS).catch(() => null);
  if (!lock) throw new ApiError("busy", TALK_MESSAGES.busy, 409);
  try {
    await takeSlotLocked(room, visitor, replaces, ownBrowser);
  } finally {
    await releaseLock("ftv:lock:talk-slots", lock).catch(() => {});
  }
}

async function takeSlotLocked(room: string, visitor: string, replaces: string | undefined, ownBrowser: boolean): Promise<void> {
  const now = Date.now();
  const ttl = holdSeconds() * 1000;
  // A slot whose room LiveKit doesn't have may only be freed once it is old enough to have been joined.
  const startedBefore = (until: number) => until - ttl < now - UNJOINED_SECONDS * 1000;
  const r = getRedis();
  const read = async (): Promise<[string, number][]> => {
    if (!r) {
      for (const [k, until] of memSlots) if (until <= now) memSlots.delete(k);
      return [...memSlots];
    }
    await r.zremrangebyscore(SLOTS_KEY, 0, now);
    const flat = await r.zrange<string[]>(SLOTS_KEY, 0, -1, { withScores: true });
    const out: [string, number][] = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
    return out;
  };
  const drop = async (members: string[]) => {
    if (!members.length) return;
    if (!r) members.forEach((k) => memSlots.delete(k));
    else await r.zrem(SLOTS_KEY, ...members);
  };
  try {
    let slots = await read();
    // "Have another chat": this browser's previous conversation ends here, wherever it was left.
    const mine = replaces ? slots.filter(([m]) => m === `${visitor}|${replaces}`).map(([m]) => m) : [];
    if (mine.length) {
      await Promise.all(mine.map((m) => roomService().deleteRoom(roomOf(m)).catch(() => {}))); // already gone is fine
      await drop(mine);
      slots = await read();
    }
    const held = slots.filter(([m]) => m.startsWith(`${visitor}|`));
    if (ownBrowser && held.length) {
      const alive = await liveRooms(held.map(([m]) => roomOf(m)));
      await drop(held.filter(([m, until]) => !alive.has(roomOf(m)) && startedBefore(until)).map(([m]) => m));
      slots = await read();
      if (slots.some(([m]) => m.startsWith(`${visitor}|`))) throw new ApiError("busy", TALK_MESSAGES.alreadyTalking, 409);
    }
    if (slots.length >= env.talk.maxConcurrent) {
      const alive = await liveRooms(slots.map(([m]) => roomOf(m)));
      await drop(slots.filter(([m, until]) => !alive.has(roomOf(m)) && startedBefore(until)).map(([m]) => m));
      slots = await read();
    }
    if (slots.length >= env.talk.maxConcurrent) throw new ApiError("busy", TALK_MESSAGES.busy, 409);
    const member = `${visitor}|${room}`;
    if (!r) memSlots.set(member, now + ttl);
    else await r.pipeline().zadd(SLOTS_KEY, { score: now + ttl, member }).expire(SLOTS_KEY, 3600).exec();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.warn("[talk] slot check failed:", e instanceof Error ? e.message.slice(0, 200) : e);
    throw new ApiError("busy", TALK_MESSAGES.busy, 409);
  }
}

export async function releaseSlot(room: string): Promise<void> {
  const r = getRedis();
  const members = r ? await r.zrange<string[]>(SLOTS_KEY, 0, -1) : [...memSlots.keys()];
  const gone = members.filter((m) => roomOf(m) === room);
  if (!gone.length) return;
  if (!r) gone.forEach((m) => memSlots.delete(m));
  else await r.zrem(SLOTS_KEY, ...gone);
}


/**
 * Everything after the guards: the voice, the profile, the slot and the token. Gives the slot back if it fails. The
 * visitor's talk is spent last, once everything else worked.
 */
export async function startTalk(input: {
  visitor: string;
  faceKey: string;
  descKey: string;
  take?: number;
  replaces?: string; // the room of this browser's previous conversation
  ownBrowser: boolean; // the visitor id is a browser cookie, not a network
  chargeVisitor: () => Promise<void>; // the visitor's daily talks: spent only once a slot is theirs
}): Promise<TalkTicket> {
  if (!talkConfigured()) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  const record = await voiceRecord(input.descKey);
  const saved = record ? takeVoice(record, input.take) : null;
  if (!record || !saved) throw new ApiError("expired", TALK_MESSAGES.retired, 410);
  // Development with FTV_MOCK_ELEVENLABS (never on a deployment): mock voices can't speak, so a real conversation
  // borrows the closest saved studio voice. Testing the chat then designs no voices and saves none.
  const voiceId = env.mockElevenLabs ? (closestStudioVoice(record.cast, input.descKey) ?? saved) : saved;
  const { pKey, fields } = await profileKeyFor(input.visitor, input.faceKey, input.descKey);
  const profile = (await savedProfile(input.visitor, pKey))?.profile;
  if (!profile) throw new ApiError("bad_request", TALK_MESSAGES.noProfile, 400);
  // The voice stays out of the pool's evictions for the whole conversation, pinned before anything slow happens; a save
  // that read the pool just before may still have taken it, so the record is read again (a pin that goes unused expires).
  await pinVoice(voiceId, holdSeconds());
  const now = await voiceRecord(input.descKey);
  if (!now || !Object.values(now.takes).some((t) => t?.voiceId === saved)) throw new ApiError("expired", TALK_MESSAGES.retired, 410);

  const room = `talk-${crypto.randomUUID()}`;
  await takeSlot(room, input.visitor, input.replaces, input.ownBrowser);
  try {
    const maxSeconds = env.talk.maxSeconds;
    await voiceSpoken(record, input.take, voiceId); // to the back of the pool's eviction queue

    const at = new AccessToken(env.livekit.apiKey(), env.livekit.apiSecret(), {
      identity: `visitor-${input.visitor.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
      name: "Visitor",
      ttl: TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE], // a microphone and nothing else
      canSubscribe: true,
      canPublishData: false, // the visitor talks; text, data and RPC are the agent's
    });
    // Applied when this token creates the room: two participants at most, closed soon after it empties, and the
    // character agent dispatched into it with its metadata.
    at.roomConfig = new RoomConfiguration({
      name: room,
      maxParticipants: 2,
      emptyTimeout: 30,
      departureTimeout: 10,
      // `again`: this browser had a chat with them already (the greeting was heard), whether or not that room still exists
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify(talkMetadata({ voiceId, profile, fields, maxSeconds, again: !!input.replaces })) })],
    });
    const token = await at.toJwt();
    // only now: a busy slot, a retired voice, a missing profile or a failure here must not cost one of the visitor's talks
    await input.chargeVisitor();
    return { serverUrl: env.livekit.url, token, room, name: profile.name, maxSeconds };
  } catch (e) {
    await releaseSlot(room).catch(() => {}); // it expires by itself; the error that matters is the one above
    throw e;
  }
}
