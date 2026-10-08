/**
 * The visitor's prefers-reduced-motion, kept live (it can change while the page is open). CSS follows it through
 * app/tokens.css; code that animates on its own reads `reducedMotion.on` (the idle life: components/scene/IdleLife.tsx).
 */
export const reducedMotion = { on: false };

if (typeof window !== "undefined" && window.matchMedia) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.on = query.matches;
  query.addEventListener("change", (e) => (reducedMotion.on = e.matches));
}
