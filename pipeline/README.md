# pipeline/

Offline tools that turn Google's [GNM Head](https://github.com/google/GNM) into everything the web app loads: the
head with its morph targets, slider and emotion data, limiter data, textures, hair and add-ons. Python 3.13 with
[uv](https://docs.astral.sh/uv/) and numpy; the official GNM package is not needed (`gnm.py` evaluates the linear
model itself). Two Node tools are pinned in `package.json`: gltfpack (meshopt compression) and glTF-Transform
(decoding and validation).

```bash
uv sync && pnpm install        # once
uv run pytest && uv run ruff check
```

`gnm.py` downloads `gnm_head.npz` (53 MB, sha256-pinned) into `.cache/` on first use. `out/` and `.cache/` are
git-ignored; the outputs that ship are committed under `web/public/` and `web/src/data/`. Keys
(`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`) are read from the environment or `../web/.env.local`.

## The head

```bash
uv run list-components        # every GNM component, grouped by region
uv run export                 # → web/public/models/head.glb, head.extra.glb, head.manifest.json, web/src/data/*.json
uv run verify                 # decode the packed files, compare with the float32 source (µm), validate → out/report.md
uv run update-sliders         # rewrite web/src/data/sliders.json from the config without re-exporting
```

- `config/components.toml`: which identity and expression components become morph targets, the σ scale, the parts.
- `config/semantic_sliders.toml`: each Shape slider as a landmark measurement; `semantic.py` solves its direction.
  `uv run semantic-landmarks` renders the landmarks, `uv run semantic-report --check` the cross-talk table and a
  −1 / 0 / +1 sheet.
- `config/age.toml`: the Age slider's mix of Shape directions (`uv run age-preview`).
- `config/emotions.json`: label means from GNM's ExpressionSampler, made by its own uv project (TensorFlow):
  `cd tools/gnm_sampler && uv run sample-emotions`. `config/expression_controls.toml`: the Fine-tune controls.
  `uv run emotions` renders the sheet.
- `export_glb.py` splits the head into parts, bakes each component at kσ as a morph target, writes the GLBs and runs
  gltfpack; `glb.py` is the GLB writer; `verify_glb.py` maps gltfpack's reordered vertices back and checks every
  position and delta.

## Ranges, limits and the stress test

```bash
uv run slider-ranges          # ends at ±4.5 SD vs adult anthropometry → config/slider_ranges.json, out/validation/ranges.md
uv run validate --sweep       # push each slider alone until geometry breaks → config/slider_breaks.json
uv run validate --vlimits     # build the app's vertex limiter → web/src/data/limits.json (grows coverage from broken faces)
uv run validate --fx-reach    # how far each Fine-tune control may go per emotion → web/src/data/fxReach.json
uv run validate --stress --quick   # drive the app (dev server on :3000) through its states and exact-check them
```

`validate/checks.py` holds the exact checks; `validate/vlimits.py` mirrors the app's limiter
(`web/src/lib/morphs/limits.ts`); `validate/stress.py` runs `web/scripts/stress-states.mjs` and writes
`out/validation/stress.md` with contact sheets. Thresholds are in `config/validation.toml`, published measurements in
`config/anthropometry.toml`.

## Hair and add-ons

```bash
uv run haircs-review select|build|apply   # pick, fit and keep HairCS styles (reviewed on /dev/hair-review)
uv run import-hair bystedt <style>        # Daniel Bystedt's Blender demo hair (CC BY-SA)
uv run groom-preview <id> && uv run export-groom <id>   # procedural grooms from config/grooms.toml
uv run groom-metrics <source:id> …        # compare grooms by numbers (volume, bend, locks, spread)
uv run brow-strands && uv run lash-strands
uv run beard-strands && uv run stubble
uv run glasses-gen                        # frames from config/glasses.toml, seated by glasses_fit.py (~1 min each)
```

Every style is written to `web/public/models/<hair|addons/category>/` and listed in that folder's `index.json`.
Strand files (`*.strands.bin`) of the hair are git-ignored and uploaded to Vercel Blob for production
(`web/scripts/upload-hair.ts`). Shared pieces: `surface.py` (the GNM skin surface and signed distance),
`head_context.py` (the head and its targets), `landmarks.py`, `eyelids.py` (lid margins and lash lines),
`addon_fit.py` (rigid binding), `guides.py` (the saved CC0 shape guides in `config/guides/`), `hair_index.py`.

## Textures, renders and naming

```bash
uv run skin-maps && uv run eye-maps       # → web/public/textures/*.ktx2
uv run bake-ao                            # Blender (headless) AO bake; needs Blender and basisu (brew install basis_universal)
uv run render --views front,quarter       # every component at −3σ / 0 / +3σ → out/renders/
uv run name-sliders                       # Claude names the raw identity/expression sliders from their renders (sliders.json `ai` blocks)
uv run propose-visemes && uv run viseme-sheet
uv run el-probe                           # live check of the ElevenLabs account (spends credits; re-records tests/fixtures/stream.ndjson)
```
