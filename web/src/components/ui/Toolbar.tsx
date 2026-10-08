"use client";

/**
 * Bottom-left over the head: Random character (a new face, style and expression at once, lib/character.ts)
 * and Reset (a blank head: face at rest, no hair, brows, lashes, beard or glasses, neutral, centred).
 * Both morph the face with the colours blending and cross-fade the hair and add-ons on the live head (lib/character.ts);
 * the buttons wait until the new pieces are on. Meanwhile both stay solid (the change is working, not unavailable):
 * the clicked one shows the spinner and is aria-busy, and neither takes a second click (aria-disabled, so the keyboard
 * focus stays put). Then a screen reader hears the new face in words. The first character's hair and add-ons download
 * a few seconds after the page loads (prepareFirst), and pointing at or focusing Random character starts them too.
 * Random face alone lives in the Shape tab.
 */
import { useEffect, useId, useState } from "react";

import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { characterSettled, prepareFirst, prepareNext, randomCharacter, resetCharacter } from "@/lib/character";
import { describeFace } from "@/lib/describeFace";

type Action = "random" | "reset";

const TIPS = {
  random: "A new face, style and expression",
  reset: "Back to a blank head",
};

export function Toolbar() {
  const ids = useId();
  const [busy, setBusy] = useState<Action | null>(null);
  // What a screen reader hears once the new face is on: the look in words (the head's own text alternative).
  const [said, setSaid] = useState({ message: "", count: 0 });
  useEffect(prepareFirst, []);
  const run = (action: Action, change: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    change().finally(() => {
      setBusy(null);
      // described once the morph has landed too (the pieces can be on before the face stops moving)
      void characterSettled().then(() => setSaid((s) => ({ message: `${action === "random" ? "New character" : "Reset"}. ${describeFace()}`, count: s.count + 1 })));
    });
  };
  // aria-disabled, not disabled, while busy: the clicked pill keeps the keyboard focus (pill in globals.css).
  const pill = "pill-secondary grid h-9"; // grid: BusySwap
  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 flex gap-2">
      <button type="button" className={pill} aria-disabled={!!busy} aria-busy={busy === "random"} onClick={() => run("random", randomCharacter)} onPointerEnter={prepareNext} onFocus={prepareNext} data-tip={TIPS.random} aria-describedby={`${ids}-random`}>
        <BusySwap busy={busy === "random"}>Random character</BusySwap>
      </button>
      <button type="button" className={pill} aria-disabled={!!busy} aria-busy={busy === "reset"} onClick={() => run("reset", resetCharacter)} data-tip={TIPS.reset} aria-describedby={`${ids}-reset`}>
        <BusySwap busy={busy === "reset"}>Reset</BusySwap>
      </button>
      {/* the hints for screen readers (the tooltip, TooltipLayer, is visual only) */}
      <span id={`${ids}-random`} className="sr-only">
        {TIPS.random}
      </span>
      <span id={`${ids}-reset`} className="sr-only">
        {TIPS.reset}
      </span>
      <Status message={said.message} count={said.count} />
    </div>
  );
}
