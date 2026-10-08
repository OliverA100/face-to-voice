import { describe, expect, it, vi } from "vitest";

// The speak route's stream in mock mode: same NDJSON shape as ElevenLabs, so the lip sync can be developed offline.
vi.mock("server-only", () => ({}));
vi.mock("../env", () => ({ env: { mockElevenLabs: true } }));

import { alignmentToCues, type Alignment } from "@/lib/lipsync/cues";

import { streamSpeech } from "../elevenlabs";

describe("mock speech stream", () => {
  it("is newline-delimited JSON: 24 kHz 16-bit PCM in 250 ms lines, the alignment on the first", async () => {
    const text = "[cheerful] Bob bought a big blue bat.";
    const lines = (await new Response(await streamSpeech("any-voice", text)).text()).trim().split("\n").map((l) => JSON.parse(l) as { audio_base64: string; alignment: Alignment | null; normalized_alignment: Alignment | null });
    const seconds = lines.reduce((s, l) => s + Buffer.from(l.audio_base64, "base64").length / 2 / 24000, 0);
    expect(seconds).toBeCloseTo(Math.max(0.6, text.length * 0.065 + 0.3), 2);
    expect(Buffer.from(lines[0].audio_base64, "base64").length).toBe(24000 * 2 * 0.25);
    expect(lines[0].alignment!.characters.join("")).toBe(text);
    expect(lines.slice(1).every((l) => l.alignment === null)).toBe(true);
    expect(alignmentToCues(lines[0].normalized_alignment!).filter((c) => c.viseme === "PP").length).toBeGreaterThanOrEqual(5);
  });
});
