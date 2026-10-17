/** Request fields more than one route accepts, validated the same way everywhere. Pure (zod and the slider list). */
import { z } from "zod";

import slidersJson from "@/data/sliders.json";

type SliderFile = { sliders: { target: string; kind: string }[]; emotions?: { items: { upper: string; lower: string }[] } };
const file = slidersJson as unknown as SliderFile;
/**
 * Every name the panel sends (lib/voice/client.ts sliderPositions, the morph store's targets): the sliders, without the
 * head pose (it turns nodes, not morphs), and each emotion's hidden upper and lower targets (lib/emotion.ts). The names
 * go into the casting's cache key, so an unknown one would make a new, paid casting of the same face.
 */
const SLIDER_NAMES: ReadonlySet<string> = new Set([
  ...file.sliders.filter((s) => s.kind !== "pose").map((s) => s.target),
  ...(file.emotions?.items ?? []).flatMap((e) => [e.upper, e.lower]),
]);

/** A face or description key: the server's own SHA-256, as hex. */
export const Key = z.string().regex(/^[a-f0-9]{64}$/);
/** One of a design's three takes. */
export const Take = z.number().int().min(0).max(2);
/** The casting's screenshot: a JPEG data URL, at most 1.5 MB. */
export const JpegDataUrl = z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(1_500_000);
/** The sliders as the panel shows them (−1 … +1 each). */
export const Weights = z.record(z.string(), z.number().min(-1).max(1)).superRefine((weights, ctx) => {
  for (const name of Object.keys(weights)) if (!SLIDER_NAMES.has(name)) ctx.addIssue({ code: "custom", message: "unknown slider", path: [name] });
});
