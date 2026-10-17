/**
 * Which browser the sound plays in, where it changes how the audio is handled: iPhones and iPads (every browser there
 * is Safari's WebKit, with the same audio), and Safari on a Mac.
 */

/**
 * iPhone or iPad, in any browser (every browser there is WebKit). iPadOS says it is a Mac, so a "Macintosh" with touch
 * counts too; Chrome and Edge everywhere also say "AppleWebKit", so that alone doesn't.
 */
export function isAppleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Safari (WebKit) on a Mac: not Chrome, Edge, Firefox or Opera there, and not an iPhone or iPad. */
export function isDesktopSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua) && !isAppleTouch();
}

/**
 * iPhone and iPad: the audio session the page asks for. "playback" (the speech player: plays with the silent switch
 * on, and pauses other apps' audio while a line plays), "play-and-record" (a chat: speaker and microphone together),
 * "auto" to hand it back. Computers are left alone: a Mac has no silent switch, and Safari there answered these by
 * muting the tab's Web Audio after a while in the background.
 */
export function setAudioSession(type: "playback" | "play-and-record" | "auto"): void {
  if (typeof navigator === "undefined" || !isAppleTouch()) return;
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    if (session.type !== type) session.type = type;
  } catch {
    /* not settable here: the default session is used */
  }
}
