import { describe, expect, it, vi } from "vitest";

// GET /api/usage answers 404 to anything but the admin token, whatever the header holds.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/server/env", () => ({ env: { usageAdminToken: "abcd", hasRedis: false, hasBlob: false, caps: { designsPerDay: 1, savesPerDay: 1, speakCharsPerDay: 1 }, voicePoolSize: 3 } }));
vi.mock("@/lib/server/elevenlabs", () => ({ subscription: async () => null }));

import { GET } from "@/app/api/usage/route";

const get = (authorization?: string) => GET(new Request("http://localhost/api/usage", { headers: authorization ? { authorization } : {} }));

describe("GET /api/usage", () => {
  it("404 without the token, with a wrong one, and with one of the same length in non-ASCII characters", async () => {
    expect((await get()).status).toBe(404);
    expect((await get("Bearer abce")).status).toBe(404);
    expect((await get("Bearer abcé")).status).toBe(404); // 4 characters, 5 bytes
  });

  it("200 with the token", async () => {
    expect((await get("Bearer abcd")).status).toBe(200);
  });
});
