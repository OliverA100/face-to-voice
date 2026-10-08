import { describe, expect, it, vi } from "vitest";

// The saved-voice pool (cache.ts) without Redis: requests that touch different takes at the same moment must all be
// remembered, or a forgotten voice is never evicted.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../env", () => ({ env: { hasRedis: false, hasBlob: false, voicePoolSize: 2 } }));

import { poolEvictions, poolList, poolRemove, poolTouch } from "../cache";

describe("voice pool", () => {
  it("keeps every take touched at the same time, and evicts the oldest beyond the pool size", async () => {
    await Promise.all([poolTouch("a#0", "va"), poolTouch("b#1", "vb"), poolTouch("c#2", "vc")]);
    expect((await poolList()).map((e) => e.voiceId).sort()).toEqual(["va", "vb", "vc"]);
    expect(await poolEvictions()).toHaveLength(1);
    await poolRemove("vb");
    expect((await poolList()).map((e) => e.descKey).sort()).toEqual(["a#0", "c#2"]);
  });
});
