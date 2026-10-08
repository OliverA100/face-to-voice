import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ isDeployed: false }));
vi.mock("server-only", () => ({}));
vi.mock("../env", () => ({ env }));
vi.mock("botid/server", () => ({ checkBotId: vi.fn(async () => ({ isBot: false })) }));

import { checkBotId } from "botid/server";

import { ApiError } from "../errors";
import { assertNotBot, assertSameOrigin } from "../guards";

const request = (headers: Record<string, string>) => new Request("https://face.example/api/voice/design", { method: "POST", headers });
const forbidden = (fn: () => unknown) => expect(fn).toThrow(new ApiError("forbidden", "Forbidden", 403));

beforeEach(() => {
  env.isDeployed = false;
});

describe("assertSameOrigin", () => {
  it("lets the app's own pages through", () => {
    expect(() => assertSameOrigin(request({ "sec-fetch-site": "same-origin", origin: "https://face.example", host: "face.example" }))).not.toThrow();
    // Vercel puts the public host in x-forwarded-host
    expect(() => assertSameOrigin(request({ origin: "https://preview.example", host: "internal", "x-forwarded-host": "preview.example" }))).not.toThrow();
  });

  it("refuses other sites, by Sec-Fetch-Site or by an Origin that is not this host", () => {
    forbidden(() => assertSameOrigin(request({ "sec-fetch-site": "cross-site" })));
    forbidden(() => assertSameOrigin(request({ origin: "https://evil.example", host: "face.example" })));
    forbidden(() => assertSameOrigin(request({ origin: "not a url", host: "face.example" })));
  });

  it("refuses requests without browser headers on any deployment (production or preview), not in development", () => {
    expect(() => assertSameOrigin(request({}))).not.toThrow();
    env.isDeployed = true;
    forbidden(() => assertSameOrigin(request({})));
  });
});

describe("assertNotBot", () => {
  it("refuses bots and lets everything through when BotID is unavailable", async () => {
    vi.mocked(checkBotId).mockResolvedValueOnce({ isBot: true } as never);
    await expect(assertNotBot()).rejects.toMatchObject({ code: "forbidden", status: 403 });
    vi.mocked(checkBotId).mockRejectedValueOnce(new Error("not on Vercel"));
    await expect(assertNotBot()).resolves.toBeUndefined();
  });
});
