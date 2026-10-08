"""Where the hair styles are listed and written: web/public/models/hair/ (index.json, the strand files, thumbnails).
index.json is version 2; web/src/lib/data.ts HairStyleDef documents its per-style fields."""
from __future__ import annotations

from .export_glb import MODELS_DIR

HAIR_MODELS_DIR = MODELS_DIR / "hair"
THUMBS_DIR = HAIR_MODELS_DIR / "thumbs"
INDEX = HAIR_MODELS_DIR / "index.json"
THUMB_SIZE = 128  # px, the picker's square thumbnails
