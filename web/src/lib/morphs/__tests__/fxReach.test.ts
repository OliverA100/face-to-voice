import { describe, expect, it } from "vitest";

import { sliders } from "@/lib/data";
import { setFxEmotion } from "@/lib/morphs/fxReach";
import { morphs } from "@/lib/morphs/store";

/** The share of its full spread a control uses now (any one target of its mix). */
function share(slider: string): [number, number] {
  const def = sliders.sliders.find((d) => d.target === slider)!;
  const [t, w] = Object.entries(def.combo!)[0];
  const c = morphs.comboOf(slider)!;
  return [Math.abs((def.comboNeg ? c.neg![Object.keys(def.comboNeg)[0]] / Object.values(def.comboNeg)[0] : c.neg![t] / w)), c.pos[t] / w];
}

describe("fine-tune reach", () => {
  morphs.configure(sliders.sliders);

  it("lets a control go its whole way where the emotion leaves room", () => {
    setFxEmotion({});
    expect(share("fx_jaw_open")[1]).toBeCloseTo(1);
    expect(share("fx_brows")).toEqual([1, 1]);
  });

  it("gives little room where the emotion already went as far as faces go", () => {
    setFxEmotion({ surprised: 1 });
    expect(share("fx_eyes_open")[1]).toBeLessThan(0.2); // Surprised: the eyes are already about as wide as eyes go
    expect(share("fx_eyes_open")[0]).toBeGreaterThan(0.95); // closing them is still free
    setFxEmotion({ happy: 1 });
    expect(share("fx_smile")[1]).toBeLessThan(0.15); // Happy already raises the corners as far as faces do
  });

  it("follows the emotion's strength, and the moved control yields to the others", () => {
    setFxEmotion({ surprised: 0.4 });
    const part = share("fx_eyes_open")[1];
    expect(part).toBeGreaterThan(0.2);
    expect(part).toBeLessThan(0.9);
    setFxEmotion({});
    morphs.set("fx_squint", 1);
    morphs.set("fx_eyes_open", -1); // closing on top of a full squint: the lids have little left to give
    expect(share("fx_squint")[1]).toBeCloseTo(1); // the squint set first keeps its place
    morphs.set("fx_eyes_open", 0);
    morphs.set("fx_squint", 0);
  });
});
