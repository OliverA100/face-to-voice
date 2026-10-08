/**
 * The colour swatches of the panel, as plain data (no three.js): the browser renders with them
 * (lib/hair.ts, lib/skin.ts) and the server accepts exactly their ids (lib/server/look.ts).
 * Ids are what the voice step hears ("skin tone: deep brown"), so keep them readable.
 */

/**
 * The swatches in the panel. `hex` is the chip the visitor sees; `shadow` → `highlight` is the ramp
 * the strands render with, root to tip. "Natural" has no ramp: each style keeps its own colours,
 * and its chip is the style's own "natural" colour from index.json (`hex` here is only the
 * fallback). Add a row and it appears in the UI.
 */
export const HAIR_COLOURS = [
  // dark → light (perceived lightness); dyed colours sit where their lightness puts them
  { id: "black", label: "Black", hex: "#1c1714", shadow: "#060505", highlight: "#2b2725" }, // dark and near neutral: a warm, light ramp read as dark brown
  { id: "dark-brown", label: "Dark brown", hex: "#3b2a21", shadow: "#1a100b", highlight: "#7a5843" },
  { id: "brown", label: "Brown", hex: "#5e4130", shadow: "#2c1a10", highlight: "#a87b5a" },
  { id: "purple", label: "Purple", hex: "#5e3190", shadow: "#2a1244", highlight: "#9e70cf" },
  { id: "auburn", label: "Auburn", hex: "#7b3d27", shadow: "#4a2013", highlight: "#c8703f" },
  { id: "natural", label: "Natural", hex: "#6b4a3a" },
  { id: "cherry-red", label: "Cherry red", hex: "#a51d28", shadow: "#530a10", highlight: "#e1505a" },
  { id: "electric-blue", label: "Electric blue", hex: "#2b5bc0", shadow: "#0f245c", highlight: "#6e9aea" },
  { id: "ginger", label: "Ginger", hex: "#a8562b", shadow: "#5e2810", highlight: "#e3904f" },
  { id: "green", label: "Green", hex: "#3a7d3e", shadow: "#143d1a", highlight: "#76c275" },
  { id: "hot-pink", label: "Hot pink", hex: "#c8327a", shadow: "#6c1240", highlight: "#f074ab" },
  { id: "teal", label: "Teal", hex: "#1f8a8a", shadow: "#0c3f40", highlight: "#5fc8c2" },
  { id: "grey", label: "Grey", hex: "#8c8781", shadow: "#4a4744", highlight: "#b9b5af" },
  { id: "blonde", label: "Blonde", hex: "#b48f5a", shadow: "#5a3a1e", highlight: "#e9cc8f" },
  { id: "lavender", label: "Lavender", hex: "#a993cc", shadow: "#5f4c80", highlight: "#d8cbec" },
  { id: "pastel-pink", label: "Pastel pink", hex: "#e2a3b9", shadow: "#9a5a72", highlight: "#f7d2df" },
  { id: "platinum", label: "Platinum", hex: "#d6c7a4", shadow: "#8a7a5a", highlight: "#f2e8cf" },
  { id: "white", label: "White", hex: "#d9d4cc", shadow: "#8d8a85", highlight: "#f4f1ec" },
] as const;
/** The style's own colour: the fallback wherever a hair colour id is unknown (the list is sorted by lightness, not by it). */
export const NATURAL_HAIR = HAIR_COLOURS.find((c) => c.id === "natural")!;

/**
 * Skin tones: a light-to-dark ramp tuned for this renderer (lib/skin.ts). Add, remove or recolour rows freely.
 */
export const SKIN_TONES = [
  { id: "porcelain", label: "Porcelain", hex: "#f6c5af" },
  { id: "fair", label: "Fair", hex: "#ecb29a" },
  { id: "light", label: "Light", hex: "#d59d84" },
  { id: "beige", label: "Beige", hex: "#be8c73" },
  { id: "tan", label: "Tan", hex: "#a87a5e" },
  { id: "bronze", label: "Bronze", hex: "#906548" },
  { id: "brown", label: "Brown", hex: "#775034" },
  { id: "deep-brown", label: "Deep brown", hex: "#613d20" },
  { id: "espresso", label: "Espresso", hex: "#492f18" },
  { id: "ebony", label: "Ebony", hex: "#241c19" },
] as const;

/**
 * Iris colours (lib/eyes.ts; "blue-grey" is the default). Add, remove or recolour rows freely.
 */
export const EYE_COLOURS = [
  { id: "blue", label: "Blue", hex: "#5a7c9a" },
  { id: "blue-grey", label: "Blue grey", hex: "#35505e" },
  { id: "grey", label: "Grey", hex: "#6c7479" },
  { id: "green", label: "Green", hex: "#5d6c40" },
  { id: "hazel", label: "Hazel", hex: "#6e5a2f" },
  { id: "amber", label: "Amber", hex: "#8f6828" },
  { id: "light-brown", label: "Light brown", hex: "#6e4a2f" },
  { id: "brown", label: "Brown", hex: "#43281a" },
  { id: "dark-brown", label: "Dark brown", hex: "#24160f" },
] as const;
