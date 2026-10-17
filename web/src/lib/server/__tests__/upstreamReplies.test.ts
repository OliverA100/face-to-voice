import { afterEach, describe, expect, it, vi } from "vitest";

// How Claude's and ElevenLabs' answers are read: anything that isn't a usable answer becomes the app's own error
// (the routes then give the day's cap back), never an upstream body, and an ElevenLabs 429 is "busy", not a failure.
const create = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("../env", () => ({
  env: { mockClaude: false, mockElevenLabs: false, claudeModel: "claude-test", anthropicKey: () => "test-key", elevenLabsKey: () => "test-key" },
}));

import { describeFace } from "../claude";
import { createVoice, UpstreamError } from "../elevenlabs";
import { ApiError } from "../errors";
import { mockCasting } from "../mockCasting";

afterEach(() => {
  create.mockReset();
  vi.unstubAllGlobals();
});

const input = { sliderSummary: "", expression: "", look: "", pickKey: "0".repeat(64), lookIds: {} };
const reply = (text: string, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text }] });
const casting = JSON.stringify(mockCasting({ lookIds: {} }));

describe("Claude's casting answer", () => {
  it("is used when it ends normally and fits the schema", async () => {
    create.mockResolvedValue(reply(casting));
    expect((await describeFace(input)).fields.persona).toBeTruthy();
  });

  it.each([
    ["a refusal", reply("I can't help with that.", "refusal")],
    ["an answer cut off by max_tokens", reply(casting.slice(0, 200), "max_tokens")],
    ["text that isn't JSON", reply("Here is the casting you asked for.")],
    ["JSON that misses the schema", reply(JSON.stringify({ persona: "pirate" }))],
  ])("turns %s into the app's 502", async (_, answer) => {
    create.mockResolvedValue(answer);
    await expect(describeFace(input)).rejects.toMatchObject({ code: "upstream", status: 502 });
  });

  it("turns a failed request into the same 502, without its message", async () => {
    create.mockRejectedValue(new Error("529 overloaded: internal detail"));
    const e = await describeFace(input).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).not.toContain("internal detail");
  });
});

describe("ElevenLabs' answers", () => {
  const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reads a good one", async () => {
    answer(200, { voice_id: "v1" });
    await expect(createVoice("face-to-voice x", "d", "g")).resolves.toBe("v1");
  });

  it("calls a 429 busy (the site is being rate-limited, not the visitor)", async () => {
    answer(429, { detail: { status: "too_many_concurrent_requests", message: "internal detail" } });
    await expect(createVoice("face-to-voice x", "d", "g")).rejects.toMatchObject({ code: "busy", status: 503 });
  });

  it("keeps any other status and code on the server, and sends the browser the app's message", async () => {
    answer(404, { detail: { status: "voice_not_found", message: "internal detail" } });
    const e = await createVoice("face-to-voice x", "d", "g").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e).toMatchObject({ upstreamStatus: 404, upstreamCode: "voice_not_found", status: 502 });
    expect((e as Error).message).not.toContain("internal detail");
  });
});
