/**
 * The sessionStorage keys the look is kept under: across reloads, while a new tab opens on the blank head. The rebuild
 * link (lib/export/characterCode.ts) writes the same entries, so each name is written once, here. No imports: the
 * link is read before anything else restores.
 */
export const STORAGE_KEYS = { face: "ftv-face", pose: "ftv-pose", hair: "ftv-hair", addons: "ftv-addons", skin: "ftv-skin", eyes: "ftv-eyes" } as const;
