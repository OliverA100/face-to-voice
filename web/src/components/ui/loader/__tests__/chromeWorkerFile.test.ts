import { describe, expect, it } from "vitest";

import { chromeWorkerSource } from "../../../../../next.config";

// Production serves the sphere's worker as one joined file (next.config.ts chromeWorkerSource): it must still run as a worker.
describe("the sphere's one-file worker", () => {
  it("runs: answers init, and reports a canvas without WebGL as failed", () => {
    const posted: unknown[] = [];
    const self: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void } = { onmessage: null, postMessage: (m) => posted.push(m) };
    new Function("self", chromeWorkerSource())(self);
    expect(typeof self.onmessage).toBe("function");
    const canvas = { getContext: () => null, addEventListener: () => {} };
    self.onmessage!({ data: { type: "init", canvas, look: {}, flow: {}, width: 1, height: 1 } });
    expect(posted).toEqual([{ type: "failed" }]); // the page then draws it itself
  });
});
