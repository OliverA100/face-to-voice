import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { skinGrid, tiePoints, tieStyle } from "@/lib/skinTie";

// The strands worker ties hair to the skin with lib/skinTie.ts, without three.js. groom.ts used to put the skin in head
// space with Vector3.applyMatrix4: the worker's arithmetic must give the same floats, or its ties could differ.
const rand = (k: number) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1;
const rest = Float32Array.from({ length: 3 * 4000 }, (_, k) => (rand(k) - 0.5) * 0.25);
const m = new Matrix4().compose(new Vector3(0.001, -0.17, 0.02), new Quaternion().setFromAxisAngle(new Vector3(1, 0.2, 0).normalize(), 0.3), new Vector3(1.03, 1.03, 1.03));

describe("skinTie", () => {
  it("puts the skin in head space exactly as three.js does", () => {
    const { head } = skinGrid(rest, m.elements);
    const v = new Vector3();
    const three = new Float32Array(rest.length);
    for (let i = 0; i < rest.length / 3; i++) v.fromArray(rest, i * 3).applyMatrix4(m).toArray(three, i * 3);
    expect(head).toEqual(three);
  });

  it("ties a style's roots, tips and points as tying each set directly", () => {
    const grid = skinGrid(rest, m.elements);
    const n = 40, p = 6;
    const positions = Float32Array.from({ length: n * p * 3 }, (_, k) => grid.head[(k * 7) % grid.head.length] + (rand(k + 9) - 0.5) * 0.004);
    const ties = tieStyle(positions, n, p, grid, { tips: true, points: true });
    const roots = new Float32Array(n * 3), tips = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) {
      roots.set(positions.subarray(s * p * 3, s * p * 3 + 3), s * 3);
      tips.set(positions.subarray((s * p + p - 1) * 3, (s * p + p) * 3), s * 3);
    }
    expect(ties.roots).toEqual(tiePoints(roots, grid));
    expect(ties.tips).toEqual(tiePoints(tips, grid));
    expect(ties.points).toEqual(tiePoints(positions, grid));
    expect(ties.roots.wts.slice(0, 3).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5); // weights of a tie sum to 1
  });
});
