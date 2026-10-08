import { describe, expect, it, vi } from "vitest";

// A slider span the caps worker worked out ahead is used at the grab only on the geometry it was worked out on: once
// head.extra.glb appends its targets, the same face values no longer mean the same face.
const posted: { type: string; key?: string; slider?: string }[] = [];
let instance: { onmessage: ((e: { data: unknown }) => void) | null } | null = null;
vi.stubGlobal(
  "Worker",
  class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror = null;
    constructor() {
      instance = this; // eslint-disable-line @typescript-eslint/no-this-alias
    }
    postMessage(m: { type: string }) {
      posted.push(m);
    }
    terminate() {}
  },
);

import type { LimitGeometry } from "../limitGeometry";
import { attachCapsWorker, readySpan, wantSpan } from "../capsClient";

describe("worker spans", () => {
  it("are not used after the geometry gains targets", () => {
    const order = [["sem_jaw", "id_000"]];
    const geom = {
      targetOrder: () => order.map((o) => [...o]),
      layout: () => ({ count: 0, groups: [], pivot: [], basis: [], order: order.map((o) => [...o]) }),
      deltas: () => [new Float32Array(0)],
    } as unknown as LimitGeometry;
    const store = { base: { sem_jaw: 0.4 }, userValue: (t: string) => (t === "sem_jaw" ? 0.4 : 0), comboOf: () => undefined };
    attachCapsWorker(geom);
    wantSpan(store, "sem_jaw", [-1, 1], true);
    const ask = posted.find((m) => m.type === "span")!;
    instance!.onmessage!({ data: { type: "span", slider: "sem_jaw", key: ask.key, span: [-0.5, 0.7] } });
    expect(readySpan(store, "sem_jaw", [-1, 1])).toEqual([-0.5, 0.7]);

    order[0].push("sem_eye_depth"); // head.extra.glb merged
    expect(readySpan(store, "sem_jaw", [-1, 1])).toBeNull();
  });

  it("are not asked for once the worker has failed, even after the geometry changed", () => {
    const order = [["sem_jaw"]];
    const geom = {
      targetOrder: () => order.map((o) => [...o]),
      layout: () => ({ count: 0, groups: [], pivot: [], basis: [], order: order.map((o) => [...o]) }),
      deltas: () => [new Float32Array(0)],
    } as unknown as LimitGeometry;
    const store = { base: { sem_jaw: 0.2 }, userValue: (t: string) => (t === "sem_jaw" ? 0.2 : 0), comboOf: () => undefined };
    attachCapsWorker(geom);
    wantSpan(store, "sem_jaw", [-1, 1], true);
    const ask = posted.filter((m) => m.type === "span").at(-1)!;
    instance!.onmessage!({ data: { type: "span", slider: "sem_jaw", key: ask.key, span: [-0.5, 0.7] } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    instance!.onmessage!({ data: { type: "error", message: "boom" } }); // the worker is gone
    order[0].push("sem_eye_depth");
    expect(() => readySpan(store, "sem_jaw", [-1, 1])).not.toThrow();
    expect(readySpan(store, "sem_jaw", [-1, 1])).toBeNull();
  });
});
