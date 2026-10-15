/** Opening the limits dialog from anywhere (an error's link, the header), and telling which errors are limits. */
const OPEN = "ftv:limits";

export function openLimits(): void {
  window.dispatchEvent(new Event(OPEN));
}

export function onOpenLimits(fn: () => void): () => void {
  window.addEventListener(OPEN, fn);
  return () => window.removeEventListener(OPEN, fn);
}

/** A refusal by a daily limit (the visitor's own, or the whole site's): its message links to the limits dialog. */
export function isLimitError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "visitor_limit" || code === "daily_cap";
}
