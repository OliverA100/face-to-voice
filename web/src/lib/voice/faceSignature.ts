/**
 * What makes two faces "the same face" for the voice: the sliders rounded to `step` (tiny drags don't count) and the
 * styled look. The server hashes it into the cache key (lib/server/keys.ts faceKey); the voice panel compares it to
 * know whether "Find a new voice" can find anything new (the same face always gets the same voices).
 */
export function quantiseFace(weights: Record<string, number>, look: Record<string, string> = {}, step = 0.05): [[string, number][], [string, string][]] {
  const q = Object.keys(weights)
    .sort()
    .filter((k) => Math.abs(weights[k]) >= step / 2)
    .map((k): [string, number] => [k, Math.round(weights[k] / step) * step]);
  const styled = Object.keys(look)
    .sort()
    .map((k): [string, string] => [k, look[k]]);
  return [q, styled];
}
