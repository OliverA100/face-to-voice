/**
 * The voice step kept across reloads, like the face (lib/faceSession.ts): the design (its three takes) and the voice in
 * use, in sessionStorage, so a reload comes back ready to speak and a new tab starts at "Find my voice". The reload hint
 * (lib/lipsync/staleTab.ts) relies on it.
 */
import type { DesignResult, SelectResult } from "@/lib/voice/client";

const STORAGE_KEY = "ftv-voice"; // sessionStorage: kept across reloads, but a new tab starts over

export type VoiceSession = { design: DesignResult; selection: SelectResult | null; chosen: number | null; designedFace: string | null };

let cached: VoiceSession | null | undefined; // read once: useSyncExternalStore needs the same object every call

/** The saved voice step (null: none, or not in a browser). */
export function voiceSession(): VoiceSession | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const raw = typeof window !== "undefined" ? window.sessionStorage.getItem(STORAGE_KEY) : null;
    const saved = raw ? (JSON.parse(raw) as Partial<VoiceSession>) : null;
    if (saved?.design?.descKey && Array.isArray(saved.design.previews)) {
      cached = { design: saved.design, selection: saved.selection ?? null, chosen: saved.chosen ?? null, designedFace: saved.designedFace ?? null };
    }
  } catch {
    /* private mode or malformed: start over */
  }
  return cached;
}

export function saveVoiceSession(s: VoiceSession | null): void {
  try {
    if (s) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: no persistence */
  }
}

/** For useSyncExternalStore: the saved voice never changes under a mounted panel (the panel itself is what writes it). */
export const subscribeVoiceSession = () => () => {};
