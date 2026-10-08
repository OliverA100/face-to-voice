import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, errorResponse, jsonBody, MESSAGES } from "../errors";

describe("errorResponse", () => {
  it("sends an ApiError as it is, with its extra fields and no caching", async () => {
    const res = errorResponse(new ApiError("visitor_limit", MESSAGES.visitor_limit, 429, { resetAt: "2030-01-01T00:00:00.000Z" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "visitor_limit", message: MESSAGES.visitor_limit, resetAt: "2030-01-01T00:00:00.000Z" });
  });

  it("turns a request body that fails validation into a 400", async () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: "x" });
    const res = errorResponse(parsed.error);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "Invalid request." });
  });

  it("hides anything unexpected behind a generic 502 and logs only its name and message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse(new TypeError("secret upstream detail"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream", message: MESSAGES.upstream });
    expect(log).toHaveBeenCalledWith("[api] unexpected:", "TypeError: secret upstream detail");
    log.mockRestore();
  });

  it("answers a request body that isn't JSON with a 400, not a 502", async () => {
    const res = errorResponse(await jsonBody(new Request("http://localhost/api/voice/design", { method: "POST", body: "not json" })).catch((e: unknown) => e));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "Invalid request." });
    expect(await jsonBody(new Request("http://localhost/", { method: "POST", body: '{"n":1}' }))).toEqual({ n: 1 });
  });
});
