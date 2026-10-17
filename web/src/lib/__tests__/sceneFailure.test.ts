import { afterEach, describe, expect, it } from "vitest";

import { SceneFailedError, setSceneFailure, unlessSceneFails } from "../sceneFailure";

afterEach(() => setSceneFailure(null));

// "Find my voice" waits for the head before taking its picture: a head that never loads must end that wait.
describe("unlessSceneFails", () => {
  it("passes the wait through while the scene is fine", async () => {
    await expect(unlessSceneFails(Promise.resolve(7))).resolves.toBe(7);
  });

  it("ends a wait that would never end once the scene fails", async () => {
    const waiting = unlessSceneFails(new Promise(() => {}));
    setSceneFailure("webgl");
    await expect(waiting).rejects.toBeInstanceOf(SceneFailedError);
  });

  it("fails at once when the scene already failed", async () => {
    setSceneFailure("download");
    await expect(unlessSceneFails(new Promise(() => {}))).rejects.toBeInstanceOf(SceneFailedError);
  });
});
