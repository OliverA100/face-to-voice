# Design

A warm, near-monochrome UI: cards framed by a hairline ring instead of a border, pill buttons, Inter at two weights,
and colour only in the loader's sphere and the things that share its look (the header logo, the busy spinner and the
voice previews' orbs). Light theme only. The design language is inspired by elevenlabs.io; no ElevenLabs logo,
wordmark, font or asset is used, and the project is not affiliated with or endorsed by ElevenLabs.

## Where the look lives

| Piece | File | Notes |
|---|---|---|
| **Tokens** | `web/src/app/tokens.css` | the single source for colours, type scale, radii, shadows and motion; the spacing rhythm is in its header comment |
| Colours | `tokens.css` `:root` | `--page`, `--surface`, `--surface-2`, `--card`, `--ink` … `--ink-4`, `--ink-hover`, `--line-dotted`, `--track`, `--fill`, `--danger` |
| Type scale | `tokens.css` `@theme` | `text-meta` 12/16, `text-label` 13/18, `text-body` 14/20, `text-input` 16/24, `text-title` 24 (28 from md) / 1.2 / −0.02em |
| Radii | `tokens.css` `@theme` | `rounded-card` 24, `rounded-tray` 16, `rounded-row` 12; pills and chips `rounded-full` |
| Shadows | `tokens.css` `@theme` | `shadow-hairline` (cards), `shadow-control` (white pills, tab indicator, thumbnails), `shadow-thumb` (slider thumb), `shadow-float` (voice card) |
| Motion | `tokens.css` + `web/src/lib/motion.ts` | see [Motion](#motion) |
| Pills and cards | `globals.css` `@utility` | `pill`, `pill-primary` (black), `pill-secondary` (white, lifted by `shadow-control`), `pill-ghost`, `card`; heights are set at the call site (`h-8` … `h-11` = 32–44 px) |
| Sliders | `globals.css` `.range` + `components/ui/panel/rangeFill.ts` | 4 px track with a soft fill from zero to the thumb, written as CSS variables without React; 16 px thumb, 1.08 on press; `.range-mid` adds a tick at zero |
| Round choices | `globals.css` `.choice`, `.thumb` + `components/ui/thumb.tsx` | hair and add-on thumbnails and colour chips; the chosen ring fades and scales in with opacity and transform only, so it stays smooth while a piece loads |
| Chosen pills | `globals.css` `.pill-choice` | emotions, hair length filters, Line chips: the chosen pill fills with ink through a layer that fades and grows in |
| Busy pills | `components/ui/Spinner.tsx` | the pill stays solid (`aria-busy`, `aria-disabled`, so focus stays) and its label gives way to the spinner: the loader's swing pre-rendered as a 21 KB strip (`src/lib/brand/spinner.webp`) moved on the compositor, so it keeps turning while the main thread is busy |
| Tooltips | `components/ui/TooltipLayer.tsx` | one tooltip for the app: any element with `data-tip` gets a warm-grey chip after 300 ms on hover (at once on keyboard focus), placed below what is visible of the element and kept in the viewport; visual only (controls carry their own accessible names) |
| Voice card | `components/ui/VoicePanel.tsx`, `useHeightTransition.ts` | floats over the bust from `xl`, sits above the sliders on smaller screens; eases to each step's height while the step fades in |
| Focus | `globals.css` `:focus-visible` | 2 px ink outline, 2 px offset; on sliders the ring circles the thumb; controls keep clear of the sticky tab bar when Tab scrolls them into view |
| Accessibility | `components/ui/RadioGroup.tsx`, `Status.tsx`, `lib/describeFace.ts` | chip rows are one Tab stop with arrow keys; sliders announce their value in words; one live region for status; the head has a text alternative that follows the look |
| Fonts | `web/src/app/layout.tsx` | Inter 400/500 for all UI, JetBrains Mono 400 for the voice prompt and debug overlays; self-hosted by `next/font` |
| Head backdrop | `web/src/components/scene/Scene.tsx` | `#f5f3f1`, equal to `--surface` |

## Changing the palette

Edit the `:root` block in `tokens.css`: every component reads colours through the Tailwind names. One value is not a
CSS variable: the WebGL clear colour in `Scene.tsx`, which must match `--surface` so the canvas blends into its card.
If the backdrop moves far from off-white, re-tune `LIGHTING` in `scene/Lighting.tsx` so the skin still reads well.

Rules that keep it coherent:
- Separate with spacing and soft surface fills, not lines. The only line in the panel is the hairline under the sticky
  tabs, shown once content scrolls under it.
- White controls are lifted by `shadow-control`; outlines are only for focus.
- Five type sizes, no bold: 400 for titles and text, 500 for section labels and the logo. Muted text is `--ink-3`
  (4.5:1 on `--surface`); `--ink-4` is for placeholders, counts and slider end labels.
- Press is `scale(0.98)` on pills and 1.08 on a slider thumb; nothing scales on hover.

## Motion

Two families. CSS reads the UI one from `tokens.css`; GSAP reads both from `MOTION` in `web/src/lib/motion.ts`, and a
test keeps the shared durations equal.

| Name | Value | Used for |
|---|---|---|
| `--dur-1` / `MOTION.quick` | 150 ms, `--ease` | hover, press, colour, focus rings |
| `--dur-2` / `MOTION.move` | 300 ms, `--ease-out-soft` | movement (tab indicator, tab switch, choice rings) and fades (`.enter`, thumbnails) |
| `--dur-3` / `MOTION.height` | 400 ms, `--ease-in-out-soft` | groups and the voice card changing height |
| `MOTION.follow` | 0.12 s | a slider dragging the face |
| `MOTION.blend` | 0.45 s | an emotion cross-fade |
| `MOTION.morph` | 0.9 s | a whole new face (Random character, Reset, Random face): shape, colours, expression and pose on one clock |
| `MOTION.crossfade` | 0.4 s | hair and add-ons swapping during a morph |

The loader, the pose sliders' 0.35 s follow, the camera's damping, idle life and lip sync keep their own timing. With
`prefers-reduced-motion` the CSS durations collapse to ~0, loading pulses stop, the loader is one still frame and the
reveal is a plain fade.

## Head loader

Until the head is ready the bust card shows a sphere and "Shaping a face". The sphere (`loader/chrome.tsx`,
`loader/chromeGl.ts`) is a simplex-noise-displaced sphere that swings between a matte, lumpy blob and a soap bubble
every 3 s. It is a bare WebGL1 shader with no libraries: the noise moves the vertices on the GPU (normals from the
noise's gradient), and the fragment shader is a small physical material that traces three.js's RoomEnvironment
analytically, so startup is one shader compile.

- **Real progress.** The loader tracks the download of head.glb and the saved hair and add-ons (`lib/headLoad.ts`);
  screen readers get it through the `progressbar` role.
- **First paint.** The sphere's opening frame ships as a 6 KB WebP poster in the server HTML. The live sphere opens on
  that frame, fades in over it, and only then starts moving. It is drawn in a Web Worker on an OffscreenCanvas
  (`loader/chromeWorker.ts`), so it keeps moving while the main thread sets up the head; without OffscreenCanvas the
  page draws it itself, and without WebGL the poster stays.
- **The reveal** (`REVEALS.swing` in `loader/engine.ts`, `SWING` in `lib/morphShader.ts`): the bubble becomes the face
  as the loader's last swing. The head appears pulled onto a sphere of the bubble's size, wearing the loader's shading
  (compiled into the head's materials as a variant) and carrying on from the loader's exact frame; then one clock
  releases every part (skin, eyes, mouth, hair, brows, lashes, beard, glasses) onto the face over ~1 s while the real
  materials fade in. The variant's shaders compile in the background before the reveal, so every reveal frame is
  17 ms on desktop.
- **Knobs:** `CHROME` in `chrome.tsx` (size, bumps, speeds), `CHROME_GL` in `chromeGl.ts` (noise, light, halo, film).
- **The 404 page** (`app/not-found.tsx`) shows the same sphere on its own, swinging and never settling
  (`loader/LoaderSphere.tsx`): the same poster and worker, no engine and no three.js. With reduced motion it is the
  poster.

The loader's finish, its looks and reveal styles, the spinner, the voice orbs, the icons and the tooltip were chosen in
style labs that stay outside the repository; what they rendered (the poster and logo CSS, the spinner and orb strips,
the icon masters) is committed. `CHROME.finish`, `CHROME.hold`, the reveal styles and `setDefaultLook` are the hooks
those labs drive.

## One look, four places

The header logo (`LogoOrb.tsx`), the favicon set, the busy spinner and the voice previews' orbs (`VoiceBlob.tsx`) are
all the loader's sphere mid-swing, rendered with the real shader and baked to small images by one recipe (in the
style lab). Each preview's orb is another moment of the swing: a ~5 KB still, and a ~66 KB strip
that plays while the voice plays, slid by a compositor animation. Still and strip are rendered as a pair, so Play
starts from the still without a jump and Pause eases back to it.

## Credits

The sphere is the author's design. The shader's simplex noise is adapted from
[webgl-noise](https://github.com/stegu/webgl-noise) (MIT), and the room and BRDF table follow three.js (MIT); see
`NOTICE`.
