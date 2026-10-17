import Anthropic from "@anthropic-ai/sdk";
import { llm } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGAIN_LINE, CharacterAgent, GIVE_UP_LINE, QUIET_MS, Stalled, withDeadline } from "./character.ts";
import { parseMetadata } from "./metadata.ts";

const meta = parseMetadata(
  JSON.stringify({ v: 1, name: "Hamish", voiceId: "abcdEFGH1234", instructions: "Be Hamish.", greeting: "Hello!", startMood: { emotion: "happy", strength: 2 }, moodTags: { happy: ["a", "b", "c"] }, maxSeconds: 180 }),
);

const delta = (text: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });

/** A stand-in for messages.stream: `events` in order, then `end` (a thrown error, or "hang" for a request that stalls). */
function fakeStream(events: object[], end: Error | "hang" | null = null) {
  let aborted = false;
  let wake: (() => void) | null = null;
  return {
    get aborted() {
      return aborted;
    },
    abort() {
      aborted = true;
      wake?.();
    },
    finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (end === "hang") await new Promise<void>((r) => (wake = r));
      if (aborted) throw new Anthropic.APIUserAbortError(); // as the SDK does (its name is plain "Error")
      if (end) throw end;
    },
  };
}

/** A character whose Claude answers with the next of `streams` each time. */
function characterWith(streams: ReturnType<typeof fakeStream>[], onGiveUp = () => {}) {
  const agent = new CharacterAgent(meta, () => {}, null, onGiveUp);
  (agent as unknown as { claude: unknown }).claude = { messages: { stream: () => streams.shift() } };
  return agent;
}

async function replyOf(agent: CharacterAgent): Promise<string> {
  const ctx = new llm.ChatContext();
  ctx.addMessage({ role: "user", content: "Hi" });
  const out = await agent.llmNode(ctx);
  let text = "";
  for await (const piece of out) text += piece;
  return text;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a reply Claude can't give", () => {
  it("is an apology the first time, then a goodbye that ends the chat", async () => {
    const giveUp = vi.fn();
    const overloaded = Object.assign(new Error("Overloaded"), { status: 529, name: "APIError" });
    const agent = characterWith([fakeStream([], overloaded), fakeStream([], overloaded)], giveUp);
    expect(await replyOf(agent)).toBe(AGAIN_LINE);
    expect(giveUp).not.toHaveBeenCalled();
    expect(await replyOf(agent)).toBe(GIVE_UP_LINE);
    expect(giveUp).toHaveBeenCalledOnce();
  });

  it("counts again from a reply that came through", async () => {
    const giveUp = vi.fn();
    const failed = () => fakeStream([], Object.assign(new Error("x"), { status: 500, name: "APIError" }));
    const agent = characterWith([failed(), fakeStream([delta("Aye, hello.")]), failed()], giveUp);
    expect(await replyOf(agent)).toBe(AGAIN_LINE);
    expect(await replyOf(agent)).toContain("Aye, hello.");
    expect(await replyOf(agent)).toBe(AGAIN_LINE);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("includes a request that goes quiet: it is cut off after QUIET_MS", async () => {
    vi.useFakeTimers();
    const stalled = fakeStream([], "hang");
    const agent = characterWith([stalled]);
    const reply = replyOf(agent);
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    expect(stalled.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await reply).toBe(AGAIN_LINE);
    expect(stalled.aborted).toBe(true);
  });
});

describe("a reply that is cut short", () => {
  it("is not a failure: no apology, and cancelled replies in a row never end the chat", async () => {
    const giveUp = vi.fn();
    const cancelled = () => fakeStream([], new Anthropic.APIUserAbortError()); // the visitor talked over it, or a preemptive reply was dropped
    const agent = characterWith([cancelled(), cancelled(), cancelled()], giveUp);
    for (let i = 0; i < 3; i++) await expect(replyOf(agent)).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(giveUp).not.toHaveBeenCalled();
  });
});

describe("withDeadline", () => {
  it("counts only the wait for the source, not the reader's time between items", async () => {
    vi.useFakeTimers();
    async function* slowReader() {
      yield 1;
      yield 2;
    }
    const onStall = vi.fn();
    const got: number[] = [];
    for await (const n of withDeadline(slowReader(), 1000, onStall)) {
      got.push(n);
      await vi.advanceTimersByTimeAsync(5000); // the reader takes its time
    }
    expect(got).toEqual([1, 2]);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fails with Stalled when the next item doesn't come in time", async () => {
    vi.useFakeTimers();
    const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>(() => {}) }) };
    const onStall = vi.fn();
    const it = withDeadline(never, 1000, onStall)[Symbol.asyncIterator]();
    const next = it.next();
    const caught = next.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await caught).toBeInstanceOf(Stalled);
    expect(onStall).toHaveBeenCalledOnce();
  });
});
