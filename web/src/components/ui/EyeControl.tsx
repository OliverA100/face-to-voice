"use client";

/** Eye colour swatches (Style tab, Colouring). The choice recolours the iris material directly. */
import { useSyncExternalStore } from "react";

import { SwatchRow } from "@/components/ui/SwatchRow";
import { EYE_COLOURS, eyeServerSnapshot, eyeSnapshot, setEyeColour, subscribeEyes } from "@/lib/eyes";

export function EyeControl() {
  const current = useSyncExternalStore(subscribeEyes, eyeSnapshot, eyeServerSnapshot);
  return <SwatchRow title="Eye colour" groupLabel="Eye colour" swatches={EYE_COLOURS} current={current} onChoose={(id) => setEyeColour(id)} />;
}
