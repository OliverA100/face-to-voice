/**
 * The header logo's orb: the loader's sphere mid-swing (a still of the bumpy blob, --orb-poster-image from
 * loader/orbPoster.css, rendered with the loader's shader), so the logo and the loader are the same sphere. Not
 * clipped to a circle: the image is transparent around its bumps. Still on purpose: at logo size motion would read as
 * flicker and cost a second WebGL canvas. Without the image it falls back to a round gradient (--orb-1/2, app/tokens.css).
 */
export function LogoOrb({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{ width: size, height: size, backgroundImage: "var(--orb-poster-image, radial-gradient(closest-side, var(--orb-2), var(--orb-1) 96%, transparent))", backgroundSize: "cover" }}
    />
  );
}
