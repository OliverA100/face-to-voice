/**
 * Opens a rebuild link (/#c=…, made by the export). FaceBuilder imports this FIRST, so it runs before any module
 * restores the tab's look: it writes the link's character into the sessionStorage entries a reload reads, and the
 * character appears exactly as it would after a reload. The hash (not ?c=) keeps the character out of server requests
 * and logs.
 *   - A reload must not undo the edits made since: the tab remembers the link it opened and doesn't apply it twice.
 *   - Pasting a link into a tab that is already open only changes the hash, so that reloads and applies it.
 *   - Next's router puts the first URL (hash included) back when it starts, so the hash is dropped again after.
 */
import { decodeCharacter, storageEntries } from "./characterCode";

const PREFIX = "#c=";
const OPENED = "ftv-link"; // sessionStorage: the link this tab last applied

function dropHash(): void {
  if (location.hash.startsWith(PREFIX)) history.replaceState(history.state, "", location.pathname + location.search);
}

function openLink(): void {
  if (!location.hash.startsWith(PREFIX)) return;
  const code = location.hash.slice(PREFIX.length);
  try {
    const character = sessionStorage.getItem(OPENED) === code ? null : decodeCharacter(code);
    if (character) {
      for (const [key, value] of Object.entries(storageEntries(character))) sessionStorage.setItem(key, value);
      sessionStorage.setItem(OPENED, code);
    }
  } catch {
    /* private mode: the blank head */
  }
  // Now, and a few more times while Next's router starts (it puts the hash back once, at a moment we can't hook).
  for (const ms of [0, 250, 1000, 3000]) setTimeout(dropHash, ms);
}

if (typeof window !== "undefined") {
  openLink();
  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith(PREFIX)) return;
    try {
      sessionStorage.removeItem(OPENED); // pasted on purpose: apply it even if it's the link this tab opened before
    } catch {
      /* private mode: nothing was remembered */
    }
    location.reload();
  });
}
