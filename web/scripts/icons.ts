/**
 * Writes the favicon / app icon set. Run from web/: `node scripts/icons.ts`.
 *
 * SOURCE picks the master image:
 *   "blob"    (shipped) the loader's sphere mid-swing, bumpy with a little rainbow, its shading deepened, to match the
 *             header logo: src/lib/brand/blob.png (1024 px, transparent). it is rendered with the
 *             loader's shader (loader/chromeGl.ts), so it changes only when the loader's finish does.
 *   "bubble"  the loader's sphere finished as a soap bubble: src/lib/brand/bubble.png.
 *   "mark"    the oscilloscope mark (src/lib/brand/marks.ts) on a rounded white tile.
 *
 * Writes (from "blob" or "bubble"):
 *   src/app/icon.png        the tab icon: the sphere alone, transparent around it, like the header logo
 *   src/app/favicon.ico     the same at 16 + 32 px, for browsers that ask for favicon.ico
 *   src/app/apple-icon.png  180 px, the sphere on the app's page colour, full-bleed (iOS rounds the corners itself)
 *   public/icon-192.png, public/icon-512.png   manifest icons (src/app/manifest.ts), inside the maskable safe zone
 * "mark" writes the same set with src/app/icon.svg in place of icon.png. Only one tab icon may exist (Next.js links
 * every icon.* file in src/app), so the other one is deleted.
 *
 * Next.js turns the src/app files into <link> tags on its own (file-based metadata).
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { BRAND_MARK_ID, markById } from "../src/lib/brand/marks.ts";

/** Which icon set to write: the loader's bumpy blob, its finished bubble, or the oscilloscope mark. */
const SOURCE = "blob" as "blob" | "bubble" | "mark";
/** How much of the tab icon the sphere fills (it is round: no tile needed; the master is cropped to the ball). */
const SPHERE_TAB = 1;
/** Home-screen icons: the sphere on this background, filling this much (inside Android's maskable safe zone, 80 %). */
const SPHERE_BG = "#fdfcfc"; // the app's page colour (manifest background_color)
const SPHERE_APP = 0.66;

/** "mark": tile and mark colours for every icon (swap them for a black tile). */
const TILE = "#fff";
const INK = "#000";
/** How much of the tile the mark fills: the tab tile keeps a visible border of tile; home-screen icons want more room (and the maskable safe zone). */
const FILL_TAB = 0.72;
const FILL_APP = 0.62;
/** Corner radius of the tab tile on the 32 grid (home-screen icons are full-bleed; the OS rounds them). */
const TAB_RADIUS = 7;

const mark = markById(BRAND_MARK_ID);
if (!mark) throw new Error(`No mark "${BRAND_MARK_ID}" in marks.ts`);
const out = (path: string) => new URL(`../${path}`, import.meta.url);

const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${inner}</svg>`;
const tile = (fill: number, radius: number) =>
  svg(`<rect width="32" height="32" rx="${radius}" fill="${TILE}"/><g color="${INK}" transform="translate(16 16) scale(${fill}) translate(-16 -16)">${mark.body}</g>`);
/**
 * Rasterise straight at `size` (density scales the 32-unit viewBox). Opaque icons use a palette PNG (smallest files);
 * the rounded tab tile keeps full RGBA, because palette quantisation turns its transparent corners opaque.
 */
const png = (source: string, size: number, palette = true) =>
  sharp(Buffer.from(source), { density: (72 * size) / 32 }).resize(size, size).png({ palette, compressionLevel: 9, effort: 10 }).toBuffer();

/** An .ico holding PNG images (supported by every browser that still asks for favicon.ico). */
function ico(images: { size: number; data: Buffer }[]) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e); // 0 means 256
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.data)]);
}

const master = new URL(`../src/lib/brand/${SOURCE === "blob" ? "blob" : "bubble"}.png`, import.meta.url);
/** The sphere `size` px, transparent around it (`fill` of the frame). */
const sphereAt = async (size: number, fill: number) => {
  const inner = Math.round(size * fill);
  const pad = Math.floor((size - inner) / 2);
  const img = await sharp(fileURLToPath(master)).resize(inner, inner, { kernel: "lanczos3" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: img, left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
};
/** The sphere on the app's background, full-bleed (home-screen icons). */
const sphereTile = async (size: number) =>
  sharp(await sphereAt(size, SPHERE_APP)).flatten({ background: SPHERE_BG }).png({ compressionLevel: 9 }).toBuffer();

const files: [string, Buffer | string][] =
  SOURCE !== "mark"
    ? [
        ["src/app/icon.png", await sphereAt(64, SPHERE_TAB)],
        ["src/app/favicon.ico", ico(await Promise.all([16, 32].map(async (size) => ({ size, data: await sphereAt(size, SPHERE_TAB) }))))],
        ["src/app/apple-icon.png", await sphereTile(180)],
        ["public/icon-192.png", await sphereTile(192)],
        ["public/icon-512.png", await sphereTile(512)],
      ]
    : [
        ["src/app/icon.svg", tile(FILL_TAB, TAB_RADIUS)],
        ["src/app/favicon.ico", ico(await Promise.all([16, 32].map(async (size) => ({ size, data: await png(tile(FILL_TAB, TAB_RADIUS), size, false) }))))],
        ["src/app/apple-icon.png", await png(tile(FILL_APP, 0), 180)],
        ["public/icon-192.png", await png(tile(FILL_APP, 0), 192)],
        ["public/icon-512.png", await png(tile(FILL_APP, 0), 512)],
      ];
// One tab icon at a time: Next.js links every icon.* file in src/app.
const other = out(SOURCE !== "mark" ? "src/app/icon.svg" : "src/app/icon.png");
if (existsSync(other)) unlinkSync(other);
for (const [path, data] of files) {
  writeFileSync(out(path), data);
  console.log(`${path.padEnd(24)} ${String(Buffer.byteLength(data)).padStart(6)} B`);
}
