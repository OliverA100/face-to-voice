/**
 * Run `fn` in the browser's next idle period (at the latest after `timeout` ms), or after
 * `fallbackMs` where there is no requestIdleCallback (older Safari). Returns the cancel, so callers
 * never pair the wrong cancel with the wrong handle.
 */
export function whenIdle(fn: () => void, timeout: number, fallbackMs: number): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, fallbackMs);
  return () => clearTimeout(id);
}
