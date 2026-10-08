/**
 * The oscilloscope mark, drawn by hand on a 32×32 grid: a head over the loudest peak of an oscilloscope trace. One of
 * the app-icon options (scripts/icons.ts SOURCE "mark"; the shipped icon is the loader's blob, lib/brand/blob.png).
 * `body` is raw SVG inner markup in `currentColor`, shared by the style lab's icon sheet and
 * scripts/icons.ts (which writes the favicon set from it), so an edit here reaches both.
 * After editing, run `node scripts/icons.ts` from web/ to regenerate the files.
 *
 * Grid rules: ~3-unit margin, nothing thinner than 3 units (1.5 px at 16 px), one colour.
 */

export type BrandMark = { id: string; name: string; idea: string; body: string };

export const MARKS: BrandMark[] = [
  {
    id: "scope",
    name: "Oscilloscope",
    idea: "Sharp zigzag peaks growing to a loud centre, like an audio scope, with a flat line either side; the head sits on the loudest peak.",
    body: `<circle fill="currentColor" cx="16" cy="7" r="3.75"/><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M3.25 22H7L10 18L13 27.5L16 14L19 27.5L22 18L25 22H28.75"/>`,
  },
];

/** The mark scripts/icons.ts builds the favicon set from. */
export const BRAND_MARK_ID = "scope";

export const markById = (id: string) => MARKS.find((m) => m.id === id);
