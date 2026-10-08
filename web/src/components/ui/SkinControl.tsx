"use client";

/** Skin tone swatches (Style tab, Colouring). The choice recolours the skin material directly. */
import { useSyncExternalStore } from "react";

import { SwatchRow } from "@/components/ui/SwatchRow";
import { setSkinTone, SKIN_TONES, skinServerSnapshot, skinSnapshot, subscribeSkin } from "@/lib/skin";

export function SkinControl() {
  const current = useSyncExternalStore(subscribeSkin, skinSnapshot, skinServerSnapshot);
  return <SwatchRow title="Skin" groupLabel="Skin tone" swatches={SKIN_TONES} current={current} onChoose={(id) => setSkinTone(id)} />;
}
