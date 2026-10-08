"use client";

/**
 * A titled row of round colour swatches (Style tab, Colouring: skin tone, eye colour), the chosen one's name on the
 * right. One Tab stop, the arrows move and choose (RadioGroup); names are aria-labels (shown as the app's tooltip:
 * data-tip).
 */
import { RadioGroup } from "@/components/ui/RadioGroup";

export type Swatch<Id extends string> = { id: Id; label: string; hex: string };

export function SwatchRow<Id extends string>({
  title,
  groupLabel,
  swatches,
  current,
  onChoose,
}: {
  title: string;
  /** The radio group's accessible name. */
  groupLabel: string;
  swatches: readonly Swatch<Id>[];
  current: Id;
  onChoose: (id: Id) => void;
}) {
  const label = swatches.find((s) => s.id === current)?.label ?? "";
  return (
    <section className="px-5 py-2.5" aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-ink">{title}</span>
        <span className="text-label text-ink-3">{label}</span>
      </div>
      <RadioGroup label={groupLabel} className="mt-2 flex flex-wrap items-center gap-2 py-0.5">
        {swatches.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={current === s.id}
            aria-label={s.label}
            data-tip={s.label}
            onClick={() => onChoose(s.id)}
            style={{ backgroundColor: s.hex }}
            className={`size-6 rounded-full choice relative shadow-hairline transition-shadow ${current === s.id ? "" : "hover:shadow-control-hover"}`}
          />
        ))}
      </RadioGroup>
    </section>
  );
}
