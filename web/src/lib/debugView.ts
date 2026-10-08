/**
 * Camera presets for comparison screenshots, reached through the debug handle (FaceBuilder.tsx):
 * `__faceToVoice.view("profile")`, `__faceToVoice.view({ target: [0, 0.3, 0.1], yaw: 30, dist: 0.3 })`,
 * `__faceToVoice.still(true)`. Nothing in the app calls this; Scene's Controls registers the camera and orbit controls
 * on mount. `view` lifts the orbit limits (a profile is outside them); `view("reset")` puts the app's view back.
 */
import type { PerspectiveCamera, Vector3 } from "three";

/** The parts of drei's OrbitControls this uses (three-stdlib is not a direct dependency). */
type Orbit = { target: Vector3; minAzimuthAngle: number; maxAzimuthAngle: number; minPolarAngle: number; maxPolarAngle: number; update(): void };

export type ViewSpec = {
  target: [number, number, number]; // what the camera looks at (world metres)
  yaw?: number; // degrees round the head; + = the camera moves to the viewer's right (sees the face's left side)
  pitch?: number; // degrees; + = camera above the target
  dist?: number; // metres from the target
  fov?: number; // degrees
};

const DEFAULT: ViewSpec = { target: [0, 0.265, 0.05], yaw: 0, pitch: 0.6, dist: 0.9, fov: 24 };

/** Whole head and close-ups. Landmarks from data/ageing.json (template space ≈ world at rest). */
const VIEWS: Record<string, ViewSpec> = {
  front: DEFAULT,
  threeQuarter: { ...DEFAULT, yaw: 40 },
  profile: { ...DEFAULT, yaw: 90 },
  back: { ...DEFAULT, yaw: 180 },
  eye: { target: [0.031, 0.3, 0.11], yaw: 12, pitch: 2, dist: 0.2 },
  mouth: { target: [0, 0.244, 0.12], yaw: 18, pitch: 0, dist: 0.22 },
  hairline: { target: [0, 0.345, 0.1], yaw: 25, pitch: 12, dist: 0.32 },
  ear: { target: [0.07, 0.28, 0.0], yaw: 90, pitch: 0, dist: 0.26 },
  beardEdge: { target: [0.045, 0.235, 0.075], yaw: 45, pitch: 0, dist: 0.3 },
  glasses: { target: [0, 0.3, 0.11], yaw: 25, pitch: 2, dist: 0.3 },
};

const rig = {
  camera: null as PerspectiveCamera | null,
  controls: null as Orbit | null,
  limits: null as null | { minAz: number; maxAz: number; minPol: number; maxPol: number },
};

/** Freezes idle life (sway, breathing, saccades, blinks) so before/after shots line up pixel for pixel. */
export const idleDebug = { still: false };

export function registerView(camera: PerspectiveCamera, controls: Orbit | null): void {
  rig.camera = camera;
  rig.controls = controls;
}

export function view(spec: string | ViewSpec): ViewSpec | null {
  const { camera, controls } = rig;
  if (!camera || !controls) return null;
  const v = typeof spec === "string" ? (spec === "reset" ? DEFAULT : VIEWS[spec]) : spec;
  if (!v) return null;
  if (!rig.limits) {
    rig.limits = { minAz: controls.minAzimuthAngle, maxAz: controls.maxAzimuthAngle, minPol: controls.minPolarAngle, maxPol: controls.maxPolarAngle };
  }
  const reset = spec === "reset";
  controls.minAzimuthAngle = reset ? rig.limits.minAz : -Infinity;
  controls.maxAzimuthAngle = reset ? rig.limits.maxAz : Infinity;
  controls.minPolarAngle = reset ? rig.limits.minPol : 0;
  controls.maxPolarAngle = reset ? rig.limits.maxPol : Math.PI;
  const yaw = ((v.yaw ?? 0) * Math.PI) / 180;
  const pitch = ((v.pitch ?? 0) * Math.PI) / 180;
  const d = v.dist ?? 0.9;
  const [x, y, z] = v.target;
  controls.target.set(x, y, z);
  camera.position.set(x + d * Math.sin(yaw) * Math.cos(pitch), y + d * Math.sin(pitch), z + d * Math.cos(yaw) * Math.cos(pitch));
  camera.fov = v.fov ?? DEFAULT.fov!;
  camera.updateProjectionMatrix();
  controls.update();
  return v;
}
