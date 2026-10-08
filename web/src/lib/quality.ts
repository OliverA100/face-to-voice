/**
 * Quality tiers: high / medium / low. A plain store (no React): the start tier comes from a quick device probe,
 * drei's PerformanceMonitor drops it a step when the frame rate sags (Scene.tsx), and `?quality=high|medium|low`
 * pins it for testing. Each feature reads its switch from TIERS, so tuning what a tier costs happens in one table.
 *
 * Order of sacrifice on a slow device: detail normals first, then texture sizes (the low
 * tier downloads the @512 maps), and last the canvas resolution (Scene.tsx). No tier uses screen-space AO (three's
 * GTAOPass): it shows no visible gain over the baked AO, and its post chain washes the picture out.
 */
export type Tier = "high" | "medium" | "low";

export const TIERS = {
  high: { detailNormals: true, textureSize: 1024 },
  medium: { detailNormals: true, textureSize: 1024 },
  low: { detailNormals: false, textureSize: 512 },
} as const;

const ORDER: Tier[] = ["low", "medium", "high"];

export const quality = { tier: "medium" as Tier, pinned: false, probed: false };

const listeners = new Set<(tier: Tier) => void>();
export function onTier(fn: (tier: Tier) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const tierSettings = () => TIERS[quality.tier];

export function setTier(tier: Tier): void {
  if (tier === quality.tier) return;
  quality.tier = tier;
  for (const fn of listeners) fn(tier);
}

/** One step down (PerformanceMonitor decline). False when already at the bottom or pinned. */
export function dropTier(): boolean {
  const i = ORDER.indexOf(quality.tier);
  if (quality.pinned || i <= 0) return false;
  setTier(ORDER[i - 1]);
  return true;
}

/**
 * The start tier from what the device tells us (Scene.tsx calls this once, with the WebGL context). Phones and
 * tablets start at medium, small-memory or software/old mobile GPUs at low, desktops with a real GPU at high.
 */
export function probeTier(gl: WebGLRenderingContext | WebGL2RenderingContext): Tier {
  if (quality.probed) return quality.tier;
  quality.probed = true;
  const pinned = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("quality") : null;
  if (pinned === "high" || pinned === "medium" || pinned === "low") {
    quality.pinned = true;
    setTier(pinned);
    return pinned;
  }
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const weakGpu = /swiftshader|llvmpipe|software|mali-[gt][0-7]\d|adreno \(tm\) [3-5]\d\d|powervr|intel\(r\) (hd|uhd) graphics [2-6]\d\d/.test(renderer);
  const tier: Tier = weakGpu || memory <= 2 ? "low" : touch || memory <= 4 ? "medium" : "high";
  setTier(tier);
  return tier;
}
