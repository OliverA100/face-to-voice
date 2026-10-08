"use client";

/**
 * Advanced, at the foot of the Shape tab: the raw GNM sliders (PCA components), numbered per area ("Head shape 3",
 * "Mouth 12", pipeline sliders_json.py). Collapsed by default: each one moves several features at once.
 */
import { sectionOf, sliders, visibleSliders } from "@/lib/data";

import { blockTitle, Chevron, Group } from "./Group";
import { type RowRefs, SliderList } from "./SliderRow";

export function AdvancedSection({ refs }: { refs: RowRefs }) {
  const defs = visibleSliders().filter((s) => sectionOf(s) === "advanced");
  const groups = sliders.groups.filter((g) => sectionOf(g) === "advanced");
  return (
    <section aria-label="Advanced" className="pt-5">
      <h3 className={`px-5 ${blockTitle}`}>Advanced</h3>
      <details className="disclose group/adv pt-1">
        <summary className="mx-3 flex cursor-pointer list-none select-none items-center justify-between gap-3 rounded-row px-2 py-2.5 transition-colors hover:bg-surface [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-body text-ink">
              Raw model sliders <span className="text-meta tabular-nums text-ink-4">{defs.length}</span>
            </span>
            <span className="block text-label text-ink-3">Each one moves several features at once.</span>
          </span>
          <Chevron className="group-open/adv:rotate-90" />
        </summary>
        <div>
          {groups.map((g) => {
            const items = defs.filter((s) => s.group === g.id);
            if (!items.length) return null;
            return (
              <Group key={g.id} label={g.label} count={items.length}>
                <SliderList defs={items} refs={refs} />
              </Group>
            );
          })}
        </div>
      </details>
    </section>
  );
}
