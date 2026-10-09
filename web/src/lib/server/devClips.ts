/**
 * Development only: every line the speak route sends (a paid generation or a cache hit) is also saved as an NDJSON clip
 * in pipeline/out/lipsync/clips/, with a .json beside it (the line, the voice, the emotion), so /dev/lipsync can replay
 * it forever without another call. The same stream is never saved twice (the file name ends in a hash of it). Outside
 * `next dev` the stream is passed through untouched.
 */
import "server-only";

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { TTS_MODEL } from "./elevenlabs";
import { completeClip } from "./speech";

/** Where the saved clips live (the repository's gitignored pipeline/out). */
export const clipsDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "..", "pipeline", "out", "lipsync", "clips");

export type ClipMeta = {
  text: string; // the visitor's line
  spoken: string; // what ElevenLabs got, emotion tag included
  voiceId: string;
  descKey: string;
  take: number | null;
  emotion: string;
  intensity: number;
  cached: boolean;
};

export function captureClip(stream: ReadableStream<Uint8Array>, meta: ClipMeta): ReadableStream<Uint8Array> {
  if (process.env.NODE_ENV !== "development") return stream;
  const [toClient, toDisk] = stream.tee();
  void (async () => {
    const ndjson = await new Response(toDisk).text();
    if (!completeClip(ndjson, meta.spoken)) return; // cut short: nothing worth replaying
    const slug = meta.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "line";
    const name = `${slug}-${createHash("sha1").update(ndjson).digest("hex").slice(0, 8)}`;
    const dir = clipsDir();
    const file = path.join(dir, `${name}.ndjson`);
    if (await access(file).then(() => true, () => false)) return;
    await mkdir(dir, { recursive: true });
    await writeFile(file, ndjson);
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ ...meta, model: TTS_MODEL, savedAt: new Date().toISOString() }, null, 2) + "\n");
    console.info(`[dev] saved the line as pipeline/out/lipsync/clips/${name}.ndjson`);
  })().catch((e) => console.warn("[dev] clip not saved:", e instanceof Error ? e.message : e));
  return toClient;
}
