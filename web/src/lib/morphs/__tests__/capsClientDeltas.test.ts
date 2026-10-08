import { describe, expect, it, vi } from "vitest";

// The caps worker sums every target in its mesh order: a span or question queued there before head.extra.glb merged
// can weigh a target it was sent without (an eye pivot's), so its deltas must reach the worker before the new order.
const posted: { type: string; target?: string }[] = [];
let terminated = 0;
vi.stubGlobal(
  "Worker",
  class {
    onmessage = null;
    onerror = null;
    postMessage(m: { type: string }) {
      posted.push(m);
    }
    terminate() {
      terminated++;
    }
  },
);

import type { LimitGeometry } from "../limitGeometry";
import { askLimiter, attachCapsWorker, wantSpan } from "../capsClient";

function geometry(order: string[][]) {
  return {
    targetOrder: () => order.map((o) => [...o]),
    // the eye pivots weigh sem_eye_depth before the meshes have it
    layout: () => ({ count: 0, groups: [], pivot: [], basis: [[["sem_eye_depth", 1]]], order: order.map((o) => [...o]) }),
    deltas: () => [new Float32Array(0)],
  } as unknown as LimitGeometry;
}

describe("caps worker deltas", () => {
  it("sends a target skipped before the meshes had it before the order that includes it", () => {
    const order = [["sem_jaw"]];
    attachCapsWorker(geometry(order));
    const values: Record<string, number> = { sem_jaw: 0.4, sem_eye_depth: 0.3 };
    const store = { base: { sem_jaw: 0.4 }, userValue: (t: string) => values[t] ?? 0, comboOf: () => undefined };
    wantSpan(store, "sem_jaw", [-1, 1], true);
    expect(posted.some((m) => m.type === "deltas" && m.target === "sem_eye_depth")).toBe(false); // not on the meshes yet

    order[0].push("sem_eye_depth"); // head.extra.glb merged
    wantSpan(store, "sem_jaw", [-1, 1], true);
    const deltas = posted.findIndex((m) => m.type === "deltas" && m.target === "sem_eye_depth");
    const newOrder = posted.findIndex((m) => m.type === "order");
    expect(deltas).toBeGreaterThanOrEqual(0);
    expect(newOrder).toBeGreaterThan(deltas);
  });

  it("answers a question in flight here when the worker is replaced", async () => {
    attachCapsWorker(geometry([["sem_jaw"]]));
    const answer = askLimiter([], { kind: "broken", face: {} });
    const before = terminated;
    attachCapsWorker(null); // the head unmounted: the worker is gone
    expect(terminated).toBe(before + 1);
    const late = new Promise((resolve) => setTimeout(() => resolve("never answered"), 50));
    expect(await Promise.race([answer, late])).toBe(false); // the limiter here (none loaded: nothing broken)
  });
});
