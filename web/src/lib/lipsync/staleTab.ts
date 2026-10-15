/**
 * iPhone and iPad (2026-10-14): a tab left open a while can play silently, the mouth moving to no sound. After a long
 * time in the background the player starts its audio over on the next Speak (takeLongHide: a new AudioContext and the
 * audio session asked for again, in the tap). Elsewhere it never does.
 *
 * Safari on a Mac had its own trouble after an idle tab (2026-10-15: lines late or silent until a new tab, a reload or a
 * new context didn't help): the player's context, left running with nothing to play, stuck the tab's output. Fixed in
 * the player, which rests its context between lines (player.ts setState); the "Reload the page" hint that was here is
 * gone, as a reload never cleared it.
 */
const LONG_HIDE_S = 2 * 60;

/** iPhone or iPad (WebKit with touch: iPadOS says it is a Mac; every browser there is WebKit). */
export function isAppleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.maxTouchPoints > 1 && /AppleWebKit/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
}

let longHide = false; // a long time hidden since the player last took it (takeLongHide)
let hiddenAt: number | null = null;
let installed = false;

/** `?staleAfterS=` shortens the wait for testing (this page view only). */
function longHideMs(): number {
  const q = Number(new URLSearchParams(window.location.search).get("staleAfterS"));
  return (Number.isFinite(q) && q > 0 ? q : LONG_HIDE_S) * 1000;
}

function install(): void {
  if (installed || typeof document === "undefined" || !isAppleTouch()) return;
  installed = true;
  if (document.visibilityState === "hidden") hiddenAt = performance.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = performance.now();
    else if (hiddenAt !== null) {
      if (performance.now() - hiddenAt >= longHideMs()) longHide = true;
      hiddenAt = null;
    }
  });
}

/** iPhone and iPad: true once after each return from a long time in the background, for the player to start its audio
 *  over (call it in the tap). Watches from the first call on. */
export function takeLongHide(): boolean {
  install();
  if (!longHide) return false;
  longHide = false;
  return true;
}
