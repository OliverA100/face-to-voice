import { BufferAttribute, BufferGeometry, Group, Mesh } from "three";
import { describe, expect, it, vi } from "vitest";

// The glasses fit tells inside from outside by counting skin crossings along a ray. A shell beard appends copies of the
// beard's skin triangles to the skin's index (lib/beardShells.ts); counted too, a frame point inside reads as outside.
vi.mock("@/lib/skinSurface", async () => {
  const { BufferAttribute, Matrix4 } = await import("three");
  const tri = (z: number) => Float32Array.from([-0.02, -0.01, z, 0.02, -0.01, z, 0, 0.02, z]);
  const index = new BufferAttribute(Uint16Array.from([0, 1, 2, 0, 1, 2]), 1); // the skin triangle, then its shell copy
  return {
    skinSurface: { mesh: { geometry: { index, userData: { baseIndexCount: 3 } } }, toHead: new Matrix4() },
    skinShape: () => ({ rest: tri(0.03), current: tri(0.05) }), // this face's skin is 2 cm further forward
    onSkinShape: () => () => {},
  };
});

import { fitGlasses, glassesFitState, GLASSES_FIT } from "../glassesFit";

describe("glasses fit with a shell beard on", () => {
  it("still sees a frame point inside the skin and seats the frame forward", async () => {
    const frame = new BufferGeometry().setAttribute("position", new BufferAttribute(Float32Array.from([0, 0, 0.04, 0.001, 0, 0.04, 0, 0.001, 0.04]), 3));
    const node = new Group().add(new Mesh(frame));
    fitGlasses(node, new Group().add(node));
    await new Promise((r) => setTimeout(r, 10));
    expect(glassesFitState.seatMm).toBeCloseTo(GLASSES_FIT.maxSeatMm);
  });
});
