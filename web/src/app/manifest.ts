import type { MetadataRoute } from "next";

/** Web app manifest. The icons are written by scripts/icons.ts from the loader's bumpy sphere (lib/brand/blob.png). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Face to Voice",
    short_name: "Face to Voice",
    description: "Shape a 3D head with sliders, get a matching ElevenLabs voice, hear it speak with lip sync, then talk to the character live.",
    start_url: "/",
    display: "standalone",
    background_color: "#fdfcfc", // --page (app/tokens.css): a manifest can't read CSS
    theme_color: "#fdfcfc",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed tile with the mark inside the safe zone, so the same files work as maskable icons.
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
