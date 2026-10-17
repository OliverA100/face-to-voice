/**
 * iPhone and iPad: a tab left open a while can play silently, the mouth moving to no sound. After a long time in the
 * background the player starts its audio over on the next Speak (takeLongHide: a new AudioContext and the audio session
 * asked for again, in the tap). Elsewhere it never does.
 *
 * Safari on a Mac has its own idle-tab trouble (lines late or silent until a new tab; a reload or a new context doesn't
 * clear it): the player's context, left running with nothing to play, sticks the tab's output. The player handles that
 * by resting its context between lines (player.ts setState), so nothing here asks for a reload.
 */
import { isAppleTouch } from "./platform";
const LONG_HIDE_S = 2 * 60;


let longHide = false; // a long time hidden since the player last took it (takeLongHide)
let hiddenAt: number | null = null;
let installed = false;

function install(): void {
  if (installed || typeof document === "undefined" || !isAppleTouch()) return;
  installed = true;
  if (document.visibilityState === "hidden") hiddenAt = performance.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = performance.now();
    else if (hiddenAt !== null) {
      if (performance.now() - hiddenAt >= LONG_HIDE_S * 1000) longHide = true;
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
