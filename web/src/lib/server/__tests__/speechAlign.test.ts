import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Spoken lines are timed by forced alignment on their own audio: the {"aligned"} line goes in front of the audio, on the
// first play and in the cache; a line the alignment could not be asked for plays on its stamps and is aligned next time.
const store = vi.hoisted(() => new Map<string, unknown>());
const pending = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void pending.push(fn()) }));
vi.mock("../env", () => ({ env: { mockElevenLabs: false, hasBlob: false } }));
vi.mock("../cache", () => ({
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: vi.fn(),
}));
vi.mock("../elevenlabs", async (real) => ({ ...(await real<typeof import("../elevenlabs")>()), streamSpeech: vi.fn(), forcedAlignment: vi.fn() }));

import { fixSqueezed, wavOf } from "../alignSpeech";
import { forcedAlignment, streamSpeech } from "../elevenlabs";
import { cachedSpeech, generateSpeech } from "../speech";

// Recorded from ElevenLabs (Flash v2.5): the alignment arrives early, the audio after it.
const FIXTURE = readFileSync(path.resolve(__dirname, "../../../../../pipeline/tests/fixtures/stream.ndjson"), "utf8");
const PETER = "Peter Piper picked a peck of pickled peppers, but Bob bought a big blue bat before breakfast.";
const text = (s: ReadableStream<Uint8Array> | null) => new Response(s).text();
const firstLine = (ndjson: string) => JSON.parse(ndjson.split("\n")[0]) as { aligned?: { characters: string[]; character_start_times_seconds: number[] } | null };
/** Forced alignment's answer for `t`: 50 ms a character from `from`. */
const fa = (t: string, from = 0.3) => ({ characters: [...t].map((c, i) => ({ text: c, start: from + i * 0.05, end: from + (i + 1) * 0.05 })), loss: 0.1 });

beforeEach(() => {
  store.clear();
  pending.splice(0);
  vi.mocked(streamSpeech).mockImplementation(async () => new Response(FIXTURE).body!);
  vi.mocked(forcedAlignment).mockReset();
});

describe("spoken lines are aligned", () => {
  it("a generation is sent and cached with its aligned line in front of the audio; a replay is not aligned again", async () => {
    vi.mocked(forcedAlignment).mockImplementation(async (_wav, t) => fa(t));
    const sent = await text(await generateSpeech("voice-1", PETER));
    expect(sent.endsWith(FIXTURE)).toBe(true); // the voice's stream as it came
    const head = firstLine(sent).aligned!;
    expect(head.characters.join("")).toBe(PETER); // the text its stamps say (the fixture's has no tag)
    expect(head.character_start_times_seconds[0]).toBeCloseTo(0.3, 6);
    const wav = vi.mocked(forcedAlignment).mock.calls[0][0];
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    await Promise.all(pending.splice(0));
    expect(await text(await cachedSpeech("voice-1", PETER))).toBe(sent);
    expect(forcedAlignment).toHaveBeenCalledTimes(1);
  });

  it("an alignment that fails plays the line on its stamps, and the next replay aligns and caches it", async () => {
    vi.mocked(forcedAlignment).mockRejectedValueOnce(new Error("timeout"));
    expect(await text(await generateSpeech("voice-1", PETER))).toBe(FIXTURE);
    await Promise.all(pending.splice(0));
    vi.mocked(forcedAlignment).mockImplementation(async (_wav, t) => fa(t));
    const replay = await text(await cachedSpeech("voice-1", PETER));
    expect(firstLine(replay).aligned).toBeTruthy();
    await Promise.all(pending.splice(0));
    expect(await text(await cachedSpeech("voice-1", PETER))).toBe(replay); // stored aligned: asked once
    expect(forcedAlignment).toHaveBeenCalledTimes(2);
  });

  it("an alignment with nothing in it is kept as {aligned: null}, not asked again", async () => {
    vi.mocked(forcedAlignment).mockResolvedValue({ characters: [] });
    const sent = await text(await generateSpeech("voice-1", PETER));
    expect(firstLine(sent)).toEqual({ aligned: null });
    await Promise.all(pending.splice(0));
    await text(await cachedSpeech("voice-1", PETER));
    expect(forcedAlignment).toHaveBeenCalledTimes(1);
  });
});

describe("fixSqueezed", () => {
  /** 16-bit audio: speech (a tone) where `loud` says, silence elsewhere, `seconds` long. */
  const audio = (seconds: number, loud: (t: number) => boolean) => {
    const n = Math.round(seconds * 24000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(loud(i / 24000) ? Math.round(Math.sin(i / 3) * 12000) : 0, i * 2);
    return b;
  };
  const chars = (words: [string, number, number][]) =>
    words.flatMap(([w, a, b], k) => [...(k ? [{ text: " ", start: a, end: a }] : []), ...[...w].map((c, i) => ({ text: c, start: a + ((b - a) * i) / w.length, end: a + ((b - a) * (i + 1)) / w.length }))]);

  it("stretches a word squeezed beside speech the alignment called a pause over that speech", () => {
    const c = chars([["an", 0, 0.1], ["X", 0.4, 0.405], ["that", 0.45, 0.7]]);
    expect(fixSqueezed(c, audio(0.8, (t) => t < 0.4 || (t > 0.45 && t < 0.7)), {})).toBe(1);
    const x = c.find((ch) => ch.text === "X")!;
    expect(x.start).toBeCloseTo(0.13, 3); // where the speech after "an" starts (30 ms past its end)
    expect(x.end).toBeCloseTo(0.405, 3);
  });

  it("leaves a short word with no speech beside it, and words as long as their sounds", () => {
    const c = chars([["an", 0, 0.1], ["X", 0.4, 0.405], ["that", 0.45, 0.7]]);
    const before = JSON.stringify(c);
    expect(fixSqueezed(c, audio(0.8, (t) => t < 0.1 || (t > 0.4 && t < 0.7)), {})).toBe(0);
    expect(JSON.stringify(c)).toBe(before);
  });

  it("wavOf writes a 24 kHz mono 16-bit header over whole samples", () => {
    const w = Buffer.from(wavOf(Buffer.alloc(1001)));
    expect(w.length).toBe(44 + 1000);
    expect(w.readUInt32LE(24)).toBe(24000);
    expect(w.readUInt32LE(40)).toBe(1000);
  });
});
