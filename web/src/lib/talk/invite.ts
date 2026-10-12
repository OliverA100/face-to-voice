/**
 * The invite-only switch, browser side. Opening the site with /?talk=<code> keeps the code for this tab (sessionStorage),
 * takes it out of the address bar, and shows "Chat"; the token route checks the code (lib/server/talk.ts). Once talking is public
 * (NEXT_PUBLIC_TALK_PUBLIC=1, with TALK_PUBLIC=1 on the server) everyone sees the button.
 */
const KEY = "ftv-talk-invite";

let cached: string | null | undefined;

/** The invite code for this tab, read once (from the URL the first time, then from sessionStorage). */
export function talkInvite(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof window === "undefined") return cached;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("talk")?.slice(0, 128) || null;
  try {
    if (fromUrl) window.sessionStorage.setItem(KEY, fromUrl);
    cached = window.sessionStorage.getItem(KEY);
    if (fromUrl && cached === fromUrl) {
      // kept: the code leaves the address bar (history, screenshots, shared links); the rest of the URL stays
      url.searchParams.delete("talk");
      window.history.replaceState(window.history.state, "", url);
    }
  } catch {
    cached = fromUrl; // storage blocked: the code stays in the URL, and works for this page
  }
  return cached;
}

/** Whether this visitor may see "Talk to …" (the server decides whether they may actually talk). */
export function talkAvailable(): boolean {
  return process.env.NEXT_PUBLIC_TALK_PUBLIC === "1" || !!talkInvite();
}
