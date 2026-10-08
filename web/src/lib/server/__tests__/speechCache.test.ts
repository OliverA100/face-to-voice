import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// A spoken line is cached (and then served free to everyone asking for it in that voice) only when the stream was the
// whole line: a stream that failed or ended early must not become the cached clip.
const store = vi.hoisted(() => new Map<string, unknown>());
const pending = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void pending.push(fn()) }));
vi.mock("../env", () => ({ env: { mockElevenLabs: true, hasBlob: false } }));
vi.mock("../cache", () => ({
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: vi.fn(),
}));
vi.mock("../elevenlabs", async (real) => ({ ...(await real<typeof import("../elevenlabs")>()), streamSpeech: vi.fn() }));

import { streamSpeech } from "../elevenlabs";
import { cachedSpeech, completeClip, generateSpeech } from "../speech";

// Recorded from ElevenLabs (Flash v2.5): the alignment arrives early, the audio after it.
const FIXTURE = readFileSync(path.resolve(__dirname, "../../../../../pipeline/tests/fixtures/stream.ndjson"), "utf8");
const PETER = "Peter Piper picked a peck of pickled peppers, but Bob bought a big blue bat before breakfast.";
const firstLines = (ndjson: string, n: number) => ndjson.split("\n").filter(Boolean).slice(0, n).join("\n") + "\n";

describe("completeClip", () => {
  it("accepts a whole recorded line, with or without the emotion tag in front", () => {
    expect(completeClip(FIXTURE, PETER)).toBe(true);
    expect(completeClip(FIXTURE, `[cheerful] ${PETER}`)).toBe(true);
  });

  it("refuses a stream cut after the alignment arrived but before the audio did", () => {
    expect(completeClip(firstLines(FIXTURE, 5), PETER)).toBe(false);
  });

  it("refuses a stream whose alignment stops short of the text", () => {
    expect(completeClip(FIXTURE, `${PETER} And then some more.`)).toBe(false);
  });

  it("refuses empty, malformed or error bodies", () => {
    expect(completeClip("", PETER)).toBe(false);
    expect(completeClip(FIXTURE + '{"audio_base64": "AAAA"', PETER)).toBe(false);
    expect(completeClip('{"detail":{"status":"quota_exceeded"}}\n', PETER)).toBe(false);
  });
});

describe("generateSpeech caches only complete streams", () => {
  const LINE = "[cheerful] Bob bought a big blue bat.";
  const real = async () => (await vi.importActual<typeof import("../elevenlabs")>("../elevenlabs")).streamSpeech("v", LINE);

  beforeEach(() => {
    store.clear();
    pending.splice(0);
  });

  const run = async () => {
    await new Response(await generateSpeech("voice-1", LINE)).text().catch(() => "");
    await Promise.all(pending.splice(0));
    return cachedSpeech("voice-1", LINE);
  };

  it("a whole stream is cached", async () => {
    vi.mocked(streamSpeech).mockImplementation(real);
    expect(await run()).not.toBeNull();
  });

  it("a stream that ends cleanly after its first chunk is not cached", async () => {
    vi.mocked(streamSpeech).mockImplementation(async () => new Response(firstLines(await new Response(await real()).text(), 1)).body!);
    expect(await run()).toBeNull();
  });

  it("a stream that errors part-way is not cached", async () => {
    vi.mocked(streamSpeech).mockImplementation(async () => {
      const first = firstLines(await new Response(await real()).text(), 1);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
          c.error(new Error("socket hang up"));
        },
      });
    });
    expect(await run()).toBeNull();
  });
});
