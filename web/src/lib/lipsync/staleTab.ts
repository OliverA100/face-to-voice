/**
 * Safari on a computer, after a tab has sat in the background a while (found 2026-10-09): its Web Audio can come back
 * a second or more late, or silent, while Safari keeps reporting it as on time (outputLatency, getOutputTimestamp), so
 * the page cannot tell. A new AudioContext inherits it; only a reload clears it. So once such a tab has been hidden for
 * STALE_AFTER_S, the speak bar offers a reload (the face and the voice survive it: lib/faceSession.ts,
 * lib/voice/voiceSession.ts). Everywhere else this stays false.
 */
const STALE_AFTER_S = 2 * 60; // short: the hint is one quiet line, and nobody knows how soon Safari drifts

/** Safari (WebKit) on a Mac: not Chrome, Edge, Firefox or Opera there, and not an iPhone or iPad (touch). */
export function isDesktopSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua) && !(navigator.maxTouchPoints > 1);
}

let stale = false;
let hiddenAt: number | null = null;
let installed = false;
const listeners = new Set<() => void>();

/** `?staleAfterS=` shortens the wait for testing (this page view only). */
function staleAfterMs(): number {
  const q = Number(new URLSearchParams(window.location.search).get("staleAfterS"));
  return (Number.isFinite(q) && q > 0 ? q : STALE_AFTER_S) * 1000;
}

function install(): void {
  if (installed || typeof document === "undefined" || !isDesktopSafari()) return;
  installed = true;
  if (document.visibilityState === "hidden") hiddenAt = performance.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = performance.now();
    else if (hiddenAt !== null) {
      if (!stale && performance.now() - hiddenAt >= staleAfterMs()) {
        stale = true;
        for (const fn of listeners) fn();
      }
      hiddenAt = null;
    }
  });
}

export function subscribeStaleTab(fn: () => void): () => void {
  install();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True once a desktop Safari tab has come back from a long time in the background (until the page is reloaded). */
export const staleTabSnapshot = () => stale;
