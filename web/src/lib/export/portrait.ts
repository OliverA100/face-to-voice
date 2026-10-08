/**
 * The export portrait: the character as the visitor styled it (shape, emotion, pose, hair, add-ons), seen from the
 * front, on a transparent background. One synchronous task on the app's own canvas, so the page never shows it:
 *
 *   1. hold still: the head and eyes go back to the Pose sliders (no sway, breathing, saccades or cursor follow) and the
 *      blink, lid-follow and lip-sync layers are zeroed. Strand pieces (hair, brows, lashes, beards) follow the skin
 *      at render time (groom.ts onBeforeRender), so they come along;
 *   2. the drawing buffer becomes size² and a square camera renders the head twice, on black and on white;
 *   3. everything is put back and the visitor's view is redrawn, before the browser paints.
 *
 * Transparency is a difference matte: where the background shows through, the two renders differ by exactly
 * (1 − alpha) × (white − black). That is exact for blended hair, alpha-to-coverage edges and glass, and keeps tone
 * mapping and every custom shader as they are on screen (a render target would need its own output pass).
 */
import { Color, PerspectiveCamera, Vector2, type WebGLRenderer } from "three";

import { headRig, NECK } from "@/components/scene/Head";
import { sceneRig } from "@/components/scene/Capture";
import { characterSettled } from "@/lib/character";
import { visemes } from "@/lib/data";
import { updateEyeUniforms } from "@/lib/eyeShader";
import { morphs, PASSING_LAYERS } from "@/lib/morphs/store";
import { clamp, LIMITS, poseRig, POSE } from "@/lib/pose";

/** Tweak freely: the portrait camera (world metres, degrees). The app's own view is fov 24 from 0.9 m. */
export const PORTRAIT = {
  size: 1024, // px, square
  target: [0, 0.27, 0.05] as [number, number, number], // what the camera looks at (between the eyes and the chin)
  dist: 0.9,
  pitch: 0.6, // camera a touch above the target, like the app's view
  fov: 26, // a little wider than the app's 24: tall hair and buns keep their headroom
};

const DEG = Math.PI / 180;

/** PNG of the character, `size`² px, transparent around the head. Waits for a Random character / Reset to land. */
export async function capturePortrait(size = PORTRAIT.size): Promise<Blob> {
  await characterSettled();
  const { gl, scene, camera } = sceneRig;
  if (!gl || !scene || !camera) throw new Error("scene not ready");

  const restore = holdStill();
  const saved = { ratio: gl.getPixelRatio(), size: gl.getSize(new Vector2()), background: scene.background };
  let onBlack: ImageData, onWhite: ImageData;
  try {
    gl.setPixelRatio(1);
    gl.setSize(size, size, false); // the drawing buffer only: the canvas keeps its CSS size
    const cam = portraitCamera();
    onBlack = renderOn(gl, cam, "#000000", size);
    onWhite = renderOn(gl, cam, "#ffffff", size);
  } finally {
    scene.background = saved.background;
    gl.setPixelRatio(saved.ratio);
    gl.setSize(saved.size.x, saved.size.y, false);
    restore();
    gl.render(scene, camera); // the visitor's view again, before the browser paints (resizing cleared the buffer)
  }
  return toPng(matte(onBlack, onWhite));
}

/** Head + eyes on the Pose sliders, passing layers off. Returns the undo. */
function holdStill(): () => void {
  const undo: (() => void)[] = [];

  // Pose only, as IdleLife would draw it with no idle life and no cursor (lib/pose.ts currentPose without `cursor`).
  const b = poseRig.base;
  const { sway, leftEye, rightEye } = headRig;
  if (sway) {
    const rotation = sway.rotation.clone();
    const y = sway.position.y;
    undo.push(() => {
      sway.rotation.copy(rotation);
      sway.position.y = y;
    });
    sway.rotation.set(-clamp(b.headPitch, LIMITS.headPitch) * DEG, clamp(b.headYaw, LIMITS.headYaw) * DEG, -clamp(b.headRoll, LIMITS.headRoll) * DEG, "YXZ");
    sway.position.y = NECK.y;
  }
  // While "look at cursor" is on, the gaze sliders are off: the eyes look straight ahead.
  const gazeYaw = poseRig.follow.on ? 0 : clamp(b.gazeYaw, LIMITS.gazeYaw);
  const gazePitch = poseRig.follow.on ? 0 : clamp(b.gazePitch, LIMITS.gazePitch);
  for (const eye of [leftEye, rightEye]) {
    if (!eye) continue;
    const rotation = eye.rotation.clone();
    undo.push(() => void eye.rotation.copy(rotation));
    eye.rotation.set(-gazePitch * DEG, gazeYaw * DEG, 0, "YXZ");
  }

  // The passing layers (blinks, the lids following the eyes, speech): remember every value, zero them, then put the
  // lid follow back for the posed gaze.
  const targets = morphs.targets();
  for (const layer of PASSING_LAYERS) {
    const kept = targets.map((t) => [t, morphs.layerValue(layer, t)] as const).filter(([, v]) => v !== 0);
    undo.push(() => kept.forEach(([t, v]) => morphs.setLayerValue(layer, t, v)));
    for (const [t] of kept) morphs.setLayerValue(layer, t, 0);
  }
  const lid = POSE.lidFollow * Math.min(1, Math.max(0, -gazePitch * DEG) / (20 * DEG)); // as IdleLife: looking down lowers the lids
  if (lid > 0) {
    for (const roles of [visemes.roles.blinkLeft, visemes.roles.blinkRight])
      for (const [t, w] of Object.entries(roles)) morphs.setLayerValue("gaze", t, lid * w);
  }

  // The eye shader shades the whites in head space, from matrices Head.tsx refreshes once per frame: refresh them for
  // the posed head now, and again for the visitor's head on the way out.
  const refreshEyes = () => {
    sceneRig.scene?.updateMatrixWorld();
    if (sway) updateEyeUniforms(sway.getObjectByName("head") ?? sway.children[0] ?? sway, leftEye, rightEye); // as Head.tsx: the glb's "head" node, else its root
  };
  refreshEyes();

  return () => {
    for (const fn of undo.reverse()) fn();
    refreshEyes();
  };
}

function portraitCamera(): PerspectiveCamera {
  const { target, dist, pitch, fov } = PORTRAIT;
  const cam = new PerspectiveCamera(fov, 1, 0.1, 5);
  cam.position.set(target[0], target[1] + dist * Math.sin(pitch * DEG), target[2] + dist * Math.cos(pitch * DEG));
  cam.lookAt(target[0], target[1], target[2]);
  cam.updateMatrixWorld();
  return cam;
}

/** One render on a plain background, copied out of the canvas in the same task (no preserveDrawingBuffer needed). */
function renderOn(gl: WebGLRenderer, cam: PerspectiveCamera, background: string, size: number): ImageData {
  const scene = sceneRig.scene!;
  scene.background = new Color(background);
  gl.render(scene, cam);
  const copy = document.createElement("canvas");
  copy.width = copy.height = size;
  const ctx = copy.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(gl.domElement, 0, 0);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Difference matte. On black a pixel is alpha·colour; on white it is alpha·colour + (1 − alpha). So
 * alpha = 1 − (white − black) and colour = black / alpha (averaged over R, G, B against 8-bit noise).
 */
export function matte(onBlack: ImageData, onWhite: ImageData): ImageData {
  const k = onBlack.data, w = onWhite.data;
  const out = new ImageData(onBlack.width, onBlack.height);
  const o = out.data;
  for (let i = 0; i < k.length; i += 4) {
    const diff = (w[i] - k[i] + w[i + 1] - k[i + 1] + w[i + 2] - k[i + 2]) / 3;
    const a = Math.min(255, Math.max(0, 255 - diff));
    if (a < 1) continue; // fully transparent: stays 0, 0, 0, 0
    const s = 255 / a;
    o[i] = Math.min(255, k[i] * s);
    o[i + 1] = Math.min(255, k[i + 1] * s);
    o[i + 2] = Math.min(255, k[i + 2] * s);
    o[i + 3] = a;
  }
  return out;
}

function toPng(image: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}
