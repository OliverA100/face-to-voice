# Architecture

Face to Voice has two halves joined by files: an offline Python **pipeline** that turns the GNM head model into
morph targets, limiter data and assets, and a **web app** that renders, constrains and voices the head. The server
side of the web app is the only part that talks to Claude and ElevenLabs.

```
 pipeline/ (uv, numpy)                         web/public, web/src/data              web/ (Next.js)
 ────────────────────────────                  ─────────────────────────             ──────────────────────────────────────────
 gnm.py        GNM npz (sha-pinned)  ──┐
 export_glb.py parts + morph targets ──┼──►  models/head.glb, head.extra.glb   ──►  Head.tsx      meshes, eye pivots, materials
 semantic.py   Shape directions      ──┤      data/sliders.json, ageing.json    ──►  morphs/store  weights → morphTargetInfluences
 emotions.py   ExpressionSampler means ┘      data/random.json                  ──►  morphs/random Random face, Distinctiveness
 validate/     ranges, exact checks  ──────►  data/limits.json, fxReach.json    ──►  morphs/limits limiter (page + Web Worker)
               stress test  ◄───────────── headless Chrome drives the real app through window.__faceToVoice (dev / ?debug)
 groom.py …    hair, brows, lashes,  ──────►  models/hair, models/addons        ──►  groom.ts      strands on the GPU, roots on the skin
               beards, glasses                                                        glassesFit.ts seat and splay at runtime
                                                                                      lipsync/       PCM player, cues, evaluator
                                                                                      server/        /api/voice/{design,select,speak}
                                                                                         │  Claude (casting)  ElevenLabs (design, TTS)
                                                                                         └─ Upstash Redis (limits, caches) + Vercel Blob (audio)
```

## Pipeline → morph targets

- **One linear model, exact targets.** A GNM face is `mean + Σ wᵢ·componentᵢ`, so a component at kσ is an exact morph
  target (k = 3; weight 1 in the app = 3σ). 30 identity and 40 expression components go into `head.glb`; the 33 Shape
  sliders and 12 emotions (each split into upper and lower face) go into `head.extra.glb`, which loads after the first
  frame and is appended to the same meshes by index. A part carries only the targets that move it by more than 0.01 mm.
- **Verified, not trusted.** gltfpack quantises positions to 16 bits and reorders vertices. `uv run verify` decodes the
  packed files, maps vertices back, and checks every position and morph delta against the float32 source (max 5.8 µm
  and 3.5 µm), and that both files share vertex order per mesh.
- **Shape sliders are solved, not picked.** For each slider `semantic.py` solves one direction over the 170 head
  components: maximise the change of its own landmark measurement (a distance, a position, or movement along the surface
  for "fullness") subject to holding every other measurement and the guards (lip seal, eye clearance), with a penalty
  for movement outside its face region and a prior that keeps the face likely under the model. Linearity makes the
  whole thing a small least-squares problem per slider.
- **Ranges from anthropometry.** `validate/ranges.py` measures the GNM mean against pooled adult surveys (ANSUR II,
  NIOSH, 3DFN) and sets each end at ±4.5 SD of the feature, pulled back where any measurement it moves would leave the
  published adult range or where a single slider first breaks geometry (`--sweep`). The UI shows −1 … +1 with each half
  scaled to its own end.
- **Age** is a mix of Shape directions taken from facial-ageing studies (`config/age.toml`) plus wrinkles drawn by the
  skin shader from landmarks, so nothing extra is downloaded. **Random face** samples the model, and a Distinctiveness
  slider pushes 2–4 striking features from different face areas toward their ends.
- **Expressions.** Twelve emotions are label means over 1,024 samples each from GNM's ExpressionSampler; sad, angry and
  afraid are composed per face part with millimetre goals, since GNM has no such labels. Each is split into an
  upper-face and a lower-face target so the mouth can step back while the voice speaks. Eleven Fine-tune controls add
  to the emotion, and their travel scales to what the emotion leaves room for (`validate --fx-reach` →
  `fxReach.json`): no measure goes past the furthest a real expression takes it.

## The limiter and the stress test

The rule is "weird faces yes, impossible faces no". Two implementations of the same checks:

| | Pipeline (`validate/checks.py`) | App (`web/src/lib/morphs/limits.ts`) |
|---|---|---|
| Purpose | the exact verdict, offline | stop sliders and animations before they break, in real time |
| Eyes | skin inside the visible eyeball; rays from the eye pivot through every eye point | closest point on candidate eye triangles; K = 32 ray candidates |
| Crossings | triangle/triangle intersection depth on the full mesh | the same test on the 6,829 triangles that ever crossed in a broken face (grid broad phase) |
| Lips | inner edge past the other lip's outer edge | same |

The app's limiter is a strict superset of the exact check (slightly tighter thresholds), so a face it lets through
passes the exact check. It answers three questions:

1. **span** (on grab): how far this slider may go each way with the others fixed, by bisection along the slider's line
   (positions are linear in one slider). The span becomes the track, so the thumb never meets a wall.
2. **caps** (on settle): how strongly blink, emotion and each viseme may play on this face, judged against the average
   face doing the same thing plus 0.5 mm, so GNM's own motion is never "broken".
3. **reach** (Random face): how far a striking feature may be pushed.

Caps, look-ahead spans and the reach questions of Random face and Random character run in a Web Worker
(`capsWorker.ts`) on a copy of the tested vertices; the page keeps a lazy stand-in (`limiter.ts`) so the 80 KB-gzip
limiter chunk loads after the head's first frame. Morph targets carry no normals, so `normals.ts` recomputes them as
the shape moves; on a slow device the live recomputes run in `normalsWorker.ts` (same arithmetic), the final one here.

**Coverage grows from failures.** `validate --vlimits` and `validate/grow.py` find broken faces (slider pairs, random
multi-slider rays, failing animation poses) and add their crossing triangles to `limits.json`.

**Stress test.** `uv run validate --stress` writes identities, runs `web/scripts/stress-states.mjs` against the app in
headless Chrome (through the `window.__faceToVoice` debug handle), and exact-checks every state the app produced:

| Family | Tested | Broken |
|---|---:|---:|
| Single sliders at both ends | 223 | 0 |
| Slider pairs at the limiter's stop | 4,224 | 0 |
| Multi-slider faces at the limiter's stop (held-out seed) | 3,000 | 3 (0.10 %) |
| Random face, Distinctiveness 0.5–2.5 | 1,500 | 2 |
| Random character | 50 | 0 |
| Extreme faces × animation | 1,470 | 8 (≤ 1.2 mm) |
| Extreme faces × fine-tune sliders | 3,395 | 14 (≤ 0.5 mm, inside the eyelid) |

The remaining multi-slider failures are the documented coverage gap: the limiter only knows crossings the pipeline has
seen. Thin-lipped extremes keep their mouth shapes capped low on purpose (teeth would otherwise show through the lips).

## Hair and add-ons

- **Strands** (`.strands.bin`, gzip, decoded in a worker) store root positions and points per strand. `groom.ts` draws
  each as a camera-facing ribbon in the vertex shader; per-tier child strands are generated on the GPU around each
  guide; alpha-to-coverage under MSAA replaces sorting; Kajiya-Kay shading with a per-point baked self-shadow; no shadow
  maps.
- **Following the skin.** Each root is tied to its three nearest skin vertices at load (by the strands worker while it
  decodes, `skinTie.ts`). Per frame only the morph weights that changed
  are summed into a root-offset texture, so hair, brows and lashes follow sliders, blinks, expressions and speech.
  Lashes also turn with the live eye and their own skin's shape change; brows follow shape changes per point.
- **Glasses** are built from numbers (`config/glasses.toml`) and seated on the average head by an optician's solver
  (pads on the nose, arms past the temples onto the ears). In the app they are rigid: identity targets on their anchor
  points (best-fit transform plus arm splay) and, when the
  shape settles, a ray-parity inside test on the skin decides how far to slide them forward (≤ 6 mm) and open the arms
  (in a worker: `glassesWorker.ts`; a new frame shows once its first fit is on).
- **Pipeline fits.** Hair is fitted onto the GNM head by similarity ICP on the cranium, roots snapped to the scalp,
  strands pushed out of the skin. Brows and beards grow inside outlines read from saved CC0 guides
  (`pipeline/config/guides/`); lashes grow along the lid margins. The stress test's add-on family checks clipping and
  floating on extreme heads.

## Voice and lip sync

```
browser                         server (route handlers)                         providers
───────                         ───────────────────────                         ─────────
screenshot, sliders, look ids ─► guards (same-origin, BotID) → visitor limit → daily cap
                                 casting cache hit? (visitor + face) ────────► Claude: casting fields (structured)
                                 prompt.ts template → descKey cache hit? ────► ElevenLabs Voice Design (3 previews)
choose a take ─────────────────► save as voice (pool LRU, slots, studio fallback) ► ElevenLabs voices
speak a line ──────────────────► tts cache (Blob) hit? ──────────────────────► ElevenLabs TTS stream + timestamps
PCM + character times ◄──────── NDJSON passed through, then written to Blob
```

- **Casting.** The browser sends a 768 px screenshot of the character as styled, the Shape slider values and the look
  as ids. Claude (Sonnet 5, vision, structured output held to a fixed schema) casts it like a game voice director:
  gender, age range, how much of a character it is, build, energy, pacing, pitch, two moods, three candidate accents, a
  persona, a timbre, a delivery quirk and a two-sentence line. `prompt.ts` turns that into the Voice Design prompt; the
  expression on the face opens the prompt's emotion and the line is written in that state. The accent is remembered per
  face at rest, so an angry and a calm version of a face get different voices of the same character.
- **Speaking.** Each line goes to `eleven_v4_turbo` with an audio tag for the expression at three strengths (e.g.
  `[cheerful]`, `[happy, bright and bouncy]`, `[overjoyed, laughing, bursting with energy]`), built on the server from
  the emotion id. On the recorded test lines every p/b/m closure seals and the lips release within ~15 ms of the burst.
- **Caching is the cost model.** Voices are keyed by the normalised description (`descriptionKey`), so everyday faces
  with the same casting share a voice and only characterful ones get their own; lines by voice, model and text. The
  casting is keyed by the visitor and the quantised face and look: it is read from a screenshot, and the same face
  renders to different bytes on every page load (idle motion), window size and GPU (measured), so the image can't be
  part of a shared key, and whatever a client sends as its screenshot must not reach another visitor. Every key carries
  `PROMPT_VERSION`.
- **No browser text in prompts.** The slider summary Claude reads is built on the server from the validated slider
  values; the look arrives as ids from the shipped lists.
- **Fail closed.** Deployed on Vercel (production and previews), the paid routes refuse to run without Redis or without
  `RATE_LIMIT_SALT`; in development everything falls back to memory. A slow Redis counts as a deny, never a free pass.
  Every paid call (casting, design, save, speech) reserves its share of the daily cap first and gives it back if the call
  fails. A spoken line is cached only when the stream was the whole line.
- **One paid job at a time.** A Redis lock per description (design) and per take (save): a second request waits for
  the first one's result instead of paying again. The voice pool is one hash field per take, so concurrent requests
  never drop each other's entries, and speaking with a voice moves it to the back of the eviction queue.
- **Lip sync** (`web/src/lib/lipsync/`): `player.ts` schedules PCM chunks gaplessly on the AudioContext clock and
  compensates output latency; `cues.ts` maps letters to visemes (TalkingHead's rules, numbers spelled out, tag
  characters dropped); `evaluator.ts` places the line on the voice onset, snaps closures (p/b/m, f/v, th) to the
  quiet-then-burst in the audio and vowels to loudness peaks, then blends with anticipation, closure dominance and
  smoothing; `LipSync.tsx` writes the result into the viseme morph layer, capped per face by the limiter.

## Export

Client-side only. `portrait.ts` renders the current character into a 1024² square on black and white and takes the
difference matte for transparency; `characterCode.ts` serialises the look (also the `/#c=` rebuild link, read before
anything restores so a reload shows exactly the linked character); `zip.ts` is a small store-only zip writer with
CRC-32; `licence.ts` decides the licence of each piece and of the whole face (the most restrictive wins). Voice
Design is not reproducible from a seed (probed), so the zip carries the chosen take's audio as the exact artefact.

## Key decisions

| Decision | Why |
|---|---|
| Morph targets, not a runtime GNM | linear model → exact, GPU-native, no WASM; 2.9 MB brotli for 125 targets |
| Two GLB files | the first frame needs 70 targets; the other 55 load once the head is on screen (a face restored after a reload fetches them with the head) |
| Weights in a plain store, not React state | sliders, tweens and idle life write at 60 fps with zero re-renders |
| Limiter on vertices, not linear probes | per-slider linear limits did not converge on multi-slider faces; geometry tests do |
| Superset limiter + offline exact check + stress test | the app stays fast, the pipeline stays exact, the stress test proves the two agree |
| Strands over textured hair cards | cards read as flat caps; strands look like hair and follow the skin root by root |
| Claude fills a schema; a template writes the prompt | prompts stay consistent, cacheable and testable; browser text never reaches a prompt |
| Save per take, LRU pool + studio voices | voice slots and monthly add/edit operations are the scarce resource, not credits |
| Client-side export | no server cost, no storage of visitors' characters |
