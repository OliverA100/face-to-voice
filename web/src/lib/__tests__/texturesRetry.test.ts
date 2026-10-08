import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebGLRenderer } from "three";

// One network blip must not cost the skin detail, iris and stubble maps for the whole session: a failed texture (or a
// failed transcoder download, which KTX2Loader itself keeps for good) is tried again by the next call.
const ktx = vi.hoisted(() => ({ made: 0, failLoads: 0, brokenTranscoder: new Set<number>(), disposed: 0 }));
vi.mock("three/examples/jsm/loaders/KTX2Loader.js", () => ({
  KTX2Loader: class {
    readonly n = ++ktx.made;
    setTranscoderPath() {
      return this;
    }
    setWorkerLimit() {
      return this;
    }
    detectSupport() {
      return this;
    }
    init() {
      return ktx.brokenTranscoder.has(this.n) ? Promise.reject(new Error("basis_transcoder.wasm: 503")) : Promise.resolve();
    }
    async loadAsync(url: string) {
      if (ktx.brokenTranscoder.has(this.n)) throw new Error("basis_transcoder.wasm: 503");
      if (ktx.failLoads > 0 && ktx.failLoads--) throw new Error(`${url}: offline`);
      return { url, loader: this.n };
    }
    dispose() {
      ktx.disposed++;
    }
  },
}));

import { loadKtx2, setTextureRenderer } from "@/lib/textures";

setTextureRenderer({} as WebGLRenderer);
afterEach(() => {
  ktx.failLoads = 0;
  ktx.brokenTranscoder.clear();
});

describe("KTX2 textures", () => {
  it("try a failed texture again on the next call", async () => {
    ktx.failLoads = 1;
    await expect(loadKtx2("/textures/a.ktx2")).rejects.toThrow("offline");
    await expect(loadKtx2("/textures/a.ktx2")).resolves.toMatchObject({ url: "/textures/a.ktx2" });
  });

  it("get a fresh loader once the transcoder failed to download", async () => {
    ktx.brokenTranscoder.add(ktx.made || 1); // the loader in use (made by the first test, or the first one made)
    await expect(loadKtx2("/textures/b.ktx2")).rejects.toThrow("503");
    await expect(loadKtx2("/textures/c.ktx2")).resolves.toMatchObject({ url: "/textures/c.ktx2" });
    expect(ktx.disposed).toBe(1);
  });
});
