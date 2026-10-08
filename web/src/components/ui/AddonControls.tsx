"use client";

/**
 * Eyebrows, eyelashes, facial hair and glasses (Style tab): one row per category, a wrapping grid of
 * round thumbnails (renders of our fitted assets, listed in addons/<category>/index.json, "None" first). Facial hair also gets colour swatches: the first
 * chip wears the hair colour (the default), the others give the beard a colour of its own.
 * The state lives in lib/addons.ts (applied straight to the meshes); this component mirrors it
 * through useSyncExternalStore, as HairControl does.
 */
import { useSyncExternalStore } from "react";

import { RadioGroup } from "@/components/ui/RadioGroup";
import { NoneMark, thumbClass, thumbImg } from "@/components/ui/thumb";
import { MODELS_BASE } from "@/lib/data";
import {
  ADDON_CATEGORIES,
  ADDON_SERVER_SNAPSHOT,
  ADDONS,
  addonSnapshot,
  addonStyleById,
  addonStyles,
  facialHairChipHex,
  onAddonChange,
  setAddonStyle,
  setFacialHairColour,
  type AddonCategory,
  type AddonSnapshot,
  type FacialHairColour,
} from "@/lib/addons";
import { HAIR_COLOURS, HAIR_SERVER_SNAPSHOT, hairSnapshot, onHairChange } from "@/lib/hair";

/** One row per category; the Style tab shows the hair-like ones under Hair and glasses on their own. */
export function AddonControls({ categories = ADDON_CATEGORIES }: { categories?: readonly AddonCategory[] }) {
  const state = useSyncExternalStore(onAddonChange, addonSnapshot, () => ADDON_SERVER_SNAPSHOT);
  return (
    <>
      {categories.map((category) => (
        <AddonRow key={category} category={category} state={state} />
      ))}
    </>
  );
}

function AddonRow({ category, state }: { category: AddonCategory; state: AddonSnapshot }) {
  const { label } = ADDONS[category];
  const chosen = state[category];
  const loading = state.loading[category];
  const current = chosen === "none" ? "None" : (addonStyleById(category, chosen)?.label ?? "");

  return (
    <section className="px-5 py-2.5" aria-label={label}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-ink">{label}</span>
        <span className="text-label text-ink-3" aria-live="polite">
          {loading ? "Loading…" : current}
        </span>
      </div>
      {/* Every style visible at once: the thumbnails wrap onto more rows (no sideways scrolling). One Tab stop, the arrows
          move and choose (RadioGroup); names are aria-labels (shown as the app's tooltip: data-tip; a title as well would be read twice). */}
      <RadioGroup label={`${label} style`} className="mt-2 flex flex-wrap gap-2 py-0.5">
        <button
          type="button"
          role="radio"
          aria-checked={chosen === "none"}
          aria-label={`No ${label.toLowerCase()}`}
          data-tip="None"
          onClick={() => setAddonStyle(category, "none")}
          className={`${thumbClass(chosen === "none", false)} bg-card`}
        >
          <NoneMark />
        </button>
        {addonStyles(category).map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={chosen === s.id}
            aria-label={s.label}
            data-tip={s.label}
            onClick={() => setAddonStyle(category, s.id)}
            className={`${thumbClass(chosen === s.id, chosen === s.id && loading)} bg-surface`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- static 128 px webp, no optimisation wanted */}
            <img src={MODELS_BASE + s.thumb} alt="" width={44} height={44} loading="lazy" draggable={false} {...thumbImg} className="size-full rounded-full object-cover" />
          </button>
        ))}
      </RadioGroup>
      {category === "facialHair" && <FacialHairColours state={state} disabled={chosen === "none"} />}
    </section>
  );
}

/** "Same as hair" first (marked by a ring inside the chip), then the hair swatches. */
function FacialHairColours({ state, disabled }: { state: AddonSnapshot; disabled: boolean }) {
  const hair = useSyncExternalStore(onHairChange, hairSnapshot, () => HAIR_SERVER_SNAPSHOT); // the first chip shows the hair colour
  const chosen = state.facialHairColour;
  const chips: { id: FacialHairColour; label: string }[] = [{ id: "hair", label: "Same as hair" }, ...HAIR_COLOURS];
  return (
    <RadioGroup label="Facial hair colour" className={`mt-3 flex flex-wrap items-center gap-2 py-0.5 transition-opacity ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={chosen === c.id}
          disabled={disabled}
          aria-label={c.label}
          data-tip={c.label}
          onClick={() => setFacialHairColour(c.id)}
          style={{ backgroundColor: facialHairChipHex(c.id, hair, state) }}
          className={`grid size-6 place-items-center rounded-full choice relative shadow-hairline transition-shadow ${chosen === c.id ? "" : "hover:shadow-control-hover"}`}
        >
          {c.id === "hair" && <span aria-hidden className="size-3 rounded-full border border-card" />}
        </button>
      ))}
    </RadioGroup>
  );
}
