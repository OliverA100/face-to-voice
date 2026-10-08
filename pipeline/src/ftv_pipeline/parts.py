"""Which GNM vertices form which mesh part, and the default material of each part.

Each part becomes its own small mesh in the .glb (glTF needs every primitive of a mesh to share
the same morph-target list, and a separate mesh per part also lets each part carry only the
targets that actually move it).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PartSpec:
    name: str  # mesh + node name in the .glb (also the key in the manifest)
    material: str  # material name; must be listed in config [export.parts].include to be shipped
    node: str  # parent node: "head", or an eye pivot ("left_eye" / "right_eye")
    groups: tuple[str, ...]  # GNM vertex groups intersected (AND)
    exclude: tuple[str, ...] = ()  # GNM vertex groups subtracted


# Priority order: a vertex belongs to the FIRST part whose mask contains it (GNM masks overlap
# only along the teeth/gums and iris/pupil boundaries). A triangle belongs to the part that most
# of its three vertices belong to, ties going to the higher-priority part.
PARTS: tuple[PartSpec, ...] = (
    PartSpec("pupil_L", "pupil", "left_eye", ("pupils", "left_eye")),
    PartSpec("pupil_R", "pupil", "right_eye", ("pupils", "right_eye")),
    PartSpec("iris_L", "iris", "left_eye", ("irises", "left_eye"), exclude=("pupils",)),
    PartSpec("iris_R", "iris", "right_eye", ("irises", "right_eye"), exclude=("pupils",)),
    PartSpec("sclera_L", "sclera", "left_eye", ("scleras", "left_eye")),
    PartSpec("sclera_R", "sclera", "right_eye", ("scleras", "right_eye")),
    # the clear outer shell of the eye (cornea bulge over the iris): the web draws only its reflections
    PartSpec("cornea_L", "cornea", "left_eye", ("eye_exteriors", "left_eye")),
    PartSpec("cornea_R", "cornea", "right_eye", ("eye_exteriors", "right_eye")),
    PartSpec("tongue", "tongue", "head", ("tongue",)),
    PartSpec("teeth", "teeth", "head", ("teeth",)),
    PartSpec("gums", "gums", "head", ("gums",), exclude=("teeth",)),
    PartSpec("mouth", "mouth", "head", ("mouth_sock",)),
    PartSpec("skin", "skin", "head", ("skin",), exclude=("mouth_sock",)),
)

# The two eye pivots are GNM's eye joints (the eyeball centres). Rotating these nodes = gaze.
EYE_PIVOTS = {"left_eye": "left_eye", "right_eye": "right_eye"}  # node name -> GNM joint name

# Default glTF materials: (sRGB hex colour, roughness). The web app overrides these in
# web/src/components/scene/materials.ts; they only make the raw .glb look sensible in viewers.
MATERIALS: dict[str, tuple[str, float]] = {
    "skin": ("#C99A7E", 0.55),
    "mouth": ("#5A1F22", 0.70),
    "gums": ("#B04A55", 0.60),
    "teeth": ("#EDE6D8", 0.35),
    "tongue": ("#B24B5A", 0.65),
    "sclera": ("#F2EFEA", 0.25),
    "iris": ("#4F6F7F", 0.35),
    "pupil": ("#050505", 0.40),
    "cornea": ("#000000", 0.03),  # transparent in the app (additive reflections only)
}
