/** Request fields more than one route accepts, validated the same way everywhere. Pure (zod only). */
import { z } from "zod";

/** A face or description key: the server's own SHA-256, as hex. */
export const Key = z.string().regex(/^[a-f0-9]{64}$/);
/** One of a design's three takes. */
export const Take = z.number().int().min(0).max(2);
/** The casting's screenshot: a JPEG data URL, at most 1.5 MB. */
export const JpegDataUrl = z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(1_500_000);
/** The sliders as the panel shows them (−1 … +1 each). */
export const Weights = z.record(z.string().max(64), z.number().min(-1).max(1));
