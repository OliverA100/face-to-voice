/**
 * Darkness inside the mouth. Teeth, gums, tongue and the mouth lining are lit like the face, so without this an open
 * mouth glows pink and white. Real mouths are dark because little light gets past the lips: this darkens each fragment by how far
 * it sits behind the lips and out to the side of the opening, where the cheeks shade it (head space, after the morph
 * targets, so it holds while the mouth opens and talks). The shadow is warm, light bounced off red tissue, not grey:
 * shaded side teeth read as teeth in shadow instead of grey shapes, and the tongue stays a dull red.
 * Zero downloads. Tweak here: MOUTH (metres, head space; the lips' front is z ≈ 0.135, the front teeth ≈ 0.126).
 */
import { Color, Matrix4, type Mesh, type MeshPhysicalMaterial } from "three";

import { headSpaceMatrix } from "@/lib/age";

export const MOUTH = {
  front: 0.13, // z where the light is still `frontLight` (the front of the front teeth)
  back: 0.104, // z where it reaches `deep`: 2.5 cm in, the tongue's visible top is already in shadow
  side: 0.03, // |x| (m) out from the middle where the side shade alone reaches `deep` (the cheeks hide the back teeth)
  frontLight: 0.82, // front teeth: a touch darker than the face
  deep: 0.10, // the darkest the inside gets (× deepTint): not black, a real mouth's shadow still shows its colour
  deepTint: "#c9a49b", // the shadow's colour (warm: light bounced off red tissue), multiplied by `deep`
  curve: 0.85, // < 1 darkens sooner behind the teeth
};

/** One uniform set per material (each mouth part has its own material and quantisation transform). */
const uniformsOf = new WeakMap<MeshPhysicalMaterial, { uMouthM: { value: Matrix4 } }>();
const mouthUniforms = {
  uMouthFront: { value: MOUTH.front },
  uMouthBack: { value: MOUTH.back },
  uMouthSide: { value: MOUTH.side },
  uMouthLight: { value: MOUTH.frontLight },
  uMouthDeep: { value: new Color(MOUTH.deepTint).multiplyScalar(MOUTH.deep) },
  uMouthCurve: { value: MOUTH.curve },
};

export function installMouthShade(material: MeshPhysicalMaterial): void {
  const own = { uMouthM: { value: new Matrix4() } };
  uniformsOf.set(material, own);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mouthUniforms, own);
    shader.vertexShader = "uniform mat4 uMouthM;\nvarying vec2 vMouthXZ;\n" + shader.vertexShader.replace(
      "#include <project_vertex>",
      "vMouthXZ = (uMouthM * vec4(transformed, 1.0)).xz;\n#include <project_vertex>",
    );
    // depth behind the front (0 at `front`, 1 at `back`) and distance out to the side (1 at `side`) combine into one
    // distance into the shade
    shader.fragmentShader =
      "uniform float uMouthFront, uMouthBack, uMouthSide, uMouthLight, uMouthCurve;\nuniform vec3 uMouthDeep;\nvarying vec2 vMouthXZ;\n" +
      shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        "float mouthD = length(vec2(max(0.0, (uMouthFront - vMouthXZ.y) / (uMouthFront - uMouthBack)), abs(vMouthXZ.x) / uMouthSide));\n" +
          "float mouthT = pow(1.0 - smoothstep(0.0, 1.0, mouthD), 1.0 / uMouthCurve);\n" +
          "outgoingLight *= mix(uMouthDeep, vec3(uMouthLight), mouthT);\n#include <opaque_fragment>",
      );
  };
  material.customProgramCacheKey = () => "mouth-shade-v2";
}

/** Head.tsx: the mesh's dequantisation + node transforms, so the shader works in head-space metres. */
export function bindMouthMesh(mesh: Mesh, material: MeshPhysicalMaterial): void {
  const own = uniformsOf.get(material);
  if (own) headSpaceMatrix(mesh, own.uMouthM.value);
}
