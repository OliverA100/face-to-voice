# HairCS hair — CC BY-NC 4.0 (non-commercial, NOT MIT)

The files in this folder are derived from the **HairCS** dataset
(https://huggingface.co/datasets/HairCS2027/HairCS), licensed under
**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**:
https://creativecommons.org/licenses/by-nc/4.0/

- Attribution: Lu, Wang, Shen, Zheng, Jiang, Yin Yang, Kui Wu. "HairCS: Reconstructing Strand-Based Hair from
  Hair Cards" (2026), https://arxiv.org/abs/2609.16465 — dataset HairCS2027/HairCS on Hugging Face.
- Non-commercial use only. These files are NOT covered by this project's MIT licence.
- Changes made: strands fitted from the HairCS head onto the GNM head, cleaned of stray strands, resampled and
  re-encoded as strands (`*.strands.bin`) by `pipeline/src/ftv_pipeline/haircs_review.py` and `import_hair.py`.
- Provenance note: the HairCS paper states its source hair-card models include artist-authored game assets
  (e.g. from The Sims Resource); the CC BY-NC 4.0 licence is as published by the dataset authors.
