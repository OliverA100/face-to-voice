import { afterEach, describe, expect, it, vi } from "vitest";

// The paid-job locks (cache.ts) without Redis: a request that outlives its lock must not free the next holder's.
vi.mock("server-only", () => ({}));
vi.mock("../env", () => ({ env: { hasRedis: false, hasBlob: false } }));

import { acquireLock, releaseLock } from "../cache";

describe("paid-job locks", () => {
  afterEach(() => vi.useRealTimers());

  it("lets only one request hold a key, and frees it on release", async () => {
    const a = await acquireLock("ftv:lock:test-1", 60);
    expect(a).toBeTruthy();
    expect(await acquireLock("ftv:lock:test-1", 60)).toBeNull();
    await releaseLock("ftv:lock:test-1", a!);
    expect(await acquireLock("ftv:lock:test-1", 60)).toBeTruthy();
  });

  it("ignores a release from a holder whose lock already expired and was taken by another request", async () => {
    vi.useFakeTimers();
    const slow = await acquireLock("ftv:lock:test-2", 60);
    vi.advanceTimersByTime(61_000); // the slow request outlived its lock
    const next = await acquireLock("ftv:lock:test-2", 60);
    expect(next).toBeTruthy();
    await releaseLock("ftv:lock:test-2", slow!); // its finally runs late
    expect(await acquireLock("ftv:lock:test-2", 60)).toBeNull(); // the next holder still has it
    await releaseLock("ftv:lock:test-2", next!);
    expect(await acquireLock("ftv:lock:test-2", 60)).toBeTruthy();
  });
});
