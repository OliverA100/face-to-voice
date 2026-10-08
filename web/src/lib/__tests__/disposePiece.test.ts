import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { describe, expect, it, vi } from "vitest";

import { disposePiece } from "../hair";

// Swapping a piece frees every texture it brought: glasses carry a metal/roughness map besides their colour map.
describe("disposePiece", () => {
  it("disposes each texture of the material once, metal/roughness included", () => {
    const map = new Texture();
    const metalRough = new Texture(); // glTF: one texture, used as both metalnessMap and roughnessMap
    const group = new Group().add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map, metalnessMap: metalRough, roughnessMap: metalRough })));
    const freed = [vi.spyOn(map, "dispose"), vi.spyOn(metalRough, "dispose")];
    disposePiece(group);
    expect(freed.map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });
});
