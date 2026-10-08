"""Shape validation: measure the face in real units, find where sliders break, stress-test every combination.

    model.py         morph weights -> vertex positions, posed exactly like the web app poses head.glb
    anthro.py        standard anthropometric measurements (mm) on any posed head, vs config/anthropometry.toml
    ranges.py        `uv run slider-ranges`: each slider's σ, its candidate ends and what they measure
    checks.py        exact geometric checks (broken = worse than the neutral face: eyes, mouth, crossings, folds)
    sweep.py         `uv run validate --sweep`: where each slider alone first breaks
    vlimits.py       `uv run validate --vlimits`: the web app's limiter (which vertices and triangles to test) + its mirror
    glbmap.py        GNM vertex id -> vertex index in the shipped head.glb (for limits.json)
    grow.py          grow the limiter from faces made elsewhere (the web app's random faces); --measure only checks them
    fights.py        `uv run validate --fights`: which Shape sliders take room from each other
    fx_reach.py      `uv run validate --fx-reach`: how far each fine-tune control may go on each emotion
    stress.py        `uv run validate --stress`: every family of faces exact-checked, report + contact sheets
    addons_check.py  hair, brows, lashes, beards and glasses on extreme faces, moved the way the web app moves them
    sheets.py        contact sheets (pyvista, headless) for the reports
    cli.py           `uv run validate`

Config: config/validation.toml. Outputs: out/validation/.
"""
