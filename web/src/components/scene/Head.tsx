"use client";

/**
 * The head itself: parses head.glb (meshopt-compressed; the bytes were fetched early by lib/headLoad.ts), assigns materials, registers every
 * mesh with the morph store, and keeps normals and eye pivots correct after the sliders settle.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { use, useEffect, useMemo, useRef } from "react";
import { Float32BufferAttribute, Group, Mesh, type MeshPhysicalMaterial, type PerspectiveCamera, Vector3 } from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { mountAddons, unmountAddons } from "@/lib/addons";
import { bindAgeMesh } from "@/lib/age";
import { loadEyeMaps, updateEyeUniforms } from "@/lib/eyeShader";
import { loadHeadExtra } from "@/lib/headExtra";
import { MODELS_BASE, manifest, visemes } from "@/lib/data";
import { mountHair, unmountHair } from "@/lib/hair";
import { bindMouthMesh } from "@/lib/mouthShade";
import { onTier } from "@/lib/quality";
import { applySkinTier, loadSkinMaps } from "@/lib/skinShader";
import { blinkRetractMm, scheduleAnimCaps } from "@/lib/morphs/animCaps";
import { attachCapsWorker } from "@/lib/morphs/capsClient";
import { LimitGeometry } from "@/lib/morphs/limitGeometry";
import { limiter, loadLimiter } from "@/lib/morphs/limiter";
import { bindSkinSurface } from "@/lib/skinSurface";
import { headBytes } from "@/lib/headLoad";
import { type ScreenCircle, headMorph, registerMorph } from "@/lib/headMorph";
import { CHROME } from "@/components/ui/loader/chrome";
import { MORPH, morphFrame, morphUniforms, setMorphLookAll } from "@/lib/morphShader";
import { NormalRefresher } from "@/lib/morphs/normals";
import { morphs, PASSING_LAYERS } from "@/lib/morphs/store";
import { markHeadVisible, onHeadVisible } from "@/lib/perf";
import { applyEyes, eyeRig } from "@/lib/eyes";
import { applySkin, skinRig } from "@/lib/skin";

import { disposeMaterials, materialFor } from "./materials";

/**
 * Live normals and eye pivots while the face moves (a morph, a drag, an emotion blend). A refresh costs ~3 ms on a
 * desktop; it runs at most once per `budget` × its own last cost, so a slow phone refreshes every few frames instead
 * of dropping them. Where one costs more than `workerFromMs` (a phone: ~25 ms), the live normals are worked out in a
 * worker instead (NormalRefresher.refreshLater: the same normals, a frame or two later). The exact settle still runs
 * here at the end.
 */
const LIVE_SETTLE = { budget: 3, workerFromMs: 8 };

/** Objects the idle animation drives. Plain module state: no React re-renders involved. */
export const headRig = {
  sway: null as Group | null, // pivot group at the neck joint
  leftEye: null as Group | null,
  rightEye: null as Group | null,
};

/** Each eye's pivot as the face's shape puts it (settle), before a blink draws it back. */
const eyeRest = [new Vector3(), new Vector3()];
const BLINK_ROLES = [visemes.roles.blinkLeft, visemes.roles.blinkRight];
let drawnBack = false;

/**
 * Per frame: on a face whose blink would press the lids into (or cut through) eyes sitting far forward, the eyeballs draw
 * back as the lids close (the limiter found how far at each stage of the blink, lib/morphs/limits.ts caps; real eyes do
 * this too), by how closed each eye is (blink and the look-down lid follow, as the store shows them). Nothing elsewhere.
 */
function drawEyesBack(): void {
  if (!blinkRetractMm(1) && !blinkRetractMm(0.5) && !drawnBack) return;
  let any = false;
  [headRig.leftEye, headRig.rightEye].forEach((node, i) => {
    if (!node) return;
    let closed = 0;
    for (const [t, w] of Object.entries(BLINK_ROLES[i])) closed = Math.max(closed, (morphs.effective(t) - morphs.userValue(t)) / w);
    const back = blinkRetractMm(Math.min(1, Math.max(0, closed))) / 1000;
    node.position.copy(eyeRest[i]);
    node.position.z -= back;
    any ||= back > 0;
  });
  drawnBack = any;
}

/** GNM's neck joint: the bust nods and turns around this point (IdleLife). */
export const NECK = new Vector3(0, 0.134, -0.007);

// One parse per download: a remount (or a style-lab replay) reuses the parsed head, as useGLTF's cache would.
// The loader is imported statically so it ships inside the Scene chunk (lib/hair.ts's lazy gltfLoader() would cost
// another round trip before the first parse).
let parsed: { from: Promise<ArrayBuffer>; gltf: Promise<GLTF> } | null = null;
function headGltf(): Promise<GLTF> {
  const from = headBytes();
  if (parsed?.from !== from) {
    const gltf = from.then((buf) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, MODELS_BASE));
    // React's use() reads these fields: once parsed, Head renders straight away instead of suspending. A suspension
    // costs ~300 ms here (React throttles Suspense retries), which is why the parse also starts at module load below.
    gltf.then((value) => Object.assign(gltf, { status: "fulfilled", value })).catch(() => {});
    parsed = { from, gltf };
  }
  return parsed.gltf;
}
// Parse as soon as this chunk loads (as useGLTF.preload would), not when Head first renders.
if (typeof window !== "undefined") headGltf().catch(() => {}); // a failure resurfaces in Head's use()

const MOUTH_PARTS = new Set(["mouth", "teeth", "gums", "tongue"]);

export function Head() {
  const scene = use(headGltf()).scene;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const canvas = gl.domElement;
  const world = useThree((s) => s.scene); // the scene with the lights (compiling the skin's look variant needs them)
  const morphLookOn = useRef(false); // the skin's look variant is on (a morph reveal is running)
  const warmFrames = useRef(0); // frames left drawing the look variant once to warm it up (compileLook)
  const refresher = useMemo(() => new NormalRefresher(), []);
  const swayRef = useRef<Group>(null);
  const settleRef = useRef<((later?: boolean) => void) | null>(null);
  const live = useRef({ seen: morphs.shapeVersion, last: 0, cost: 0 }); // the live settle below (useFrame)

  useEffect(() => {
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    for (const m of meshes) {
      // gltfpack drops mesh names but keeps our named part nodes as the parents.
      const part = m.parent?.name || m.name;
      m.material = materialFor(part);
      if (part === "skin") bindAgeMesh(m); // the Age slider's wrinkles need the skin's rest positions in template space
      if (MOUTH_PARTS.has(part)) bindMouthMesh(m, m.material as MeshPhysicalMaterial); // depth behind the lips
      m.frustumCulled = false; // the head is always in view; morphs move vertices anyway
      morphs.bind(m);
      refresher.add(m);
    }
    // Procedural hair follows the skin's recomputed shape (lib/skinSurface.ts, lib/groom.ts).
    const skinMesh = meshes.find((m) => (m.parent?.name || m.name) === "skin");
    // The scalp tint under procedural hair (lib/skinShader.ts); zeros = no hair.
    skinMesh?.geometry.setAttribute("aHairCover", new Float32BufferAttribute(new Float32Array(skinMesh.geometry.getAttribute("position").count), 1));
    const unbindSkin = skinMesh ? bindSkinSurface(skinMesh, refresher) : () => {};
    // The limiter reads the vertices that can break from the same CPU morph data (lib/morphs/limits.ts). It loads now
    // (lib/morphs/limiter.ts: it is not in the page's first JavaScript); the caps worker gets the vertices as soon as it
    // is here (lib/morphs/capsClient.ts; it sets its own limiter up off the main thread). The page's limiter (slider
    // ends, Random face) sets up after the first frame, still under the loader: it takes ~0.1 s on a laptop and ~0.5 s
    // on a slow phone, which would otherwise hold the first frame back.
    let disposed = false;
    let limiterTimer = 0;
    let offLimiter = () => {};
    void loadLimiter()
      .then(({ limiter: real }) => {
        if (disposed) return;
        const limitGeom = real.doc.version === 2 ? new LimitGeometry(refresher, meshes, real.doc.parts, real.doc.vertices) : null;
        attachCapsWorker(limitGeom);
        offLimiter = onHeadVisible(() => {
          limiterTimer = window.setTimeout(() => !disposed && limiter.attach(limitGeom), 0);
        });
        scheduleAnimCaps(); // the settle at mount came before the limiter
      })
      .catch((err) => console.warn("[limits] not loaded:", err instanceof Error ? err.message : err));
    // Hair caps attach under the head's root node so they nod with the bust (lib/hair.ts).
    // Brows, lashes, beard and glasses attach there too (lib/addons.ts).
    const root = scene.getObjectByName("head") ?? scene;
    mountHair(root);
    mountAddons(root);
    // The skin material takes the visitor's tone (lib/skin.ts recolours it in place).
    skinRig.material = materialFor("skin");
    applySkin();
    // The skin's maps (AO, regions, pores) arrive after the head is on screen: never on the first view's path.
    const skin = skinRig.material;
    // A quality drop (lib/quality.ts) turns the skin's pores off (lib/skinShader.ts).
    const stopTier = onTier(() => applySkinTier(skin));
    // Every morphing material's look variant compiles in the background once the head is on screen, well before any reveal:
    // switch it on, let three issue the compile (parallel where the GPU supports it), switch it back for the next frame.
    // Again when a reveal is coming (prepareMorph): the skin's detail maps and the iris map arrive after the first
    // frame and change the programs' defines, which a variant compiled earlier wouldn't match (a 400 ms stall at the
    // hand-over).
    const compileLook = () => {
      if (morphLookOn.current) return;
      performance.mark("morph-compile");
      setMorphLookAll(true); // head parts, hair, brows, lashes, beards, glasses
      try {
        void gl.compileAsync(scene, camera, world)
          .then(() => {
            // …and draw one frame with it (the head is still under the loader): the GPU driver builds the pipeline for
            // a program at its first draw, which the compile can't do, and that first draw costs 40–130 ms when it
            // falls on the reveal's first frame. uMorph = 1 and uMorphSkin = 1: drawn exactly as the head looks without the variant.
            if (morphLookOn.current || disposed) return;
            setMorphLookAll(true);
            warmFrames.current = 2;
          })
          .catch(() => {});
      } catch (err) {
        console.warn("morph look precompile:", err); // (three's compile step throws synchronously) the reveal compiles it instead
      } finally {
        setMorphLookAll(false); // never left on: the head would stay in the bubble's look
      }
    };
    let precompile = 0;
    const offPrecompile = onHeadVisible(() => {
      precompile = window.setTimeout(compileLook, 0);
    });
    const stopMaps = onHeadVisible(() => {
      void loadSkinMaps(skin).catch((err) => console.error("skin maps:", err));
      void loadEyeMaps(materialFor("iris")).catch((err) => console.error("eye maps:", err));
    });
    // Both irises share one material; lib/eyes.ts recolours it in place.
    eyeRig.material = materialFor("iris");
    applyEyes();
    headRig.sway = swayRef.current;
    headRig.leftEye = scene.getObjectByName("left_eye") as Group | null;
    headRig.rightEye = scene.getObjectByName("right_eye") as Group | null;

    // Eye pivots follow identity: pivot = template pivot + Σ weight · basis (weights include mix sliders
    // such as Head size, which move the raw head_* targets). The weights are the ones the mesh shows (clamped): with
    // the unclamped slider sum, a mix pushing a target past its clamp would move the eye but not its socket.
    const pivots = (["left_eye", "right_eye"] as const).map((name, i) => ({
      rest: eyeRest[i],
      node: scene.getObjectByName(name),
      base: new Vector3().fromArray(manifest.nodes[name].pivot),
      basis: Object.entries(manifest.nodes[name].identity_pivot_basis),
    }));
    const tmp = new Vector3();
    const settle = (later = false) => {
      live.current.seen = morphs.shapeVersion; // this shape is done: the live settle needn't do it again this frame
      scheduleAnimCaps(); // how far blink, emotion and speech may go on this face (idle time)
      const held = (t: string) => morphs.effective(t, PASSING_LAYERS); // the held shape: a blink or a word must not stay in the shading
      if (!later || !refresher.refreshLater(held)) refresher.refresh(held);
      for (const p of pivots) {
        if (!p.node) continue;
        tmp.copy(p.base);
        for (const [target, delta] of p.basis) {
          const w = morphs.effective(target); // what the mesh shows (clamped), so the eye stays in its socket
          if (w) {
            tmp.x += w * delta[0];
            tmp.y += w * delta[1];
            tmp.z += w * delta[2];
          }
        }
        p.node.position.copy(tmp);
        p.rest.copy(tmp);
      }
    };
    // The loader's morph reveal (lib/headMorph.ts): the bubble on screen → a sphere in view space around the face's
    // depth; hair and add-ons (everything under the head that isn't one of its own meshes) wait until it is done.
    const stopMorph = registerMorph((bubble: ScreenCircle, style) => {
      const box = canvas.getBoundingClientRect();
      camera.updateMatrixWorld();
      const face = new Vector3();
      for (const eye of [headRig.leftEye, headRig.rightEye]) if (eye) face.add(eye.getWorldPosition(tmp).multiplyScalar(0.5));
      face.applyMatrix4(camera.matrixWorldInverse); // view space
      const depth = -face.z + MORPH.behind; // the sphere's centre: inside the head, behind the face
      const tan = Math.tan(((camera.fov / 2) * Math.PI) / 180);
      const ndcX = ((bubble.x - box.left) / box.width) * 2 - 1;
      const ndcY = 1 - ((bubble.y - box.top) / box.height) * 2;
      morphUniforms.uMorphCentre.value.set(ndcX * depth * tan * camera.aspect, ndcY * depth * tan, -depth);
      morphUniforms.uMorphRadius.value = (bubble.r / (box.height / 2)) * depth * tan;
      morphUniforms.uMorphFace.value.copy(face);
      morphUniforms.uMorphHue.value = bubble.clock ?? 0;
      morphUniforms.uMorphDrift.value = bubble.drift ?? (bubble.clock ?? CHROME.start) * CHROME.speed; // where the loader's noise is
      morphUniforms.uMorphTurn.value = bubble.turn ?? 0;
      morphFrame(style, 0, 0);
      performance.mark("morph-begin");
      setMorphLookAll(true); // the bubble's look on everything (+ the skin's spikes), compiled in the background (below)
      morphLookOn.current = true;
    }, compileLook);
    const unsubscribe = morphs.onSettle(() => settle());
    settle();
    settleRef.current = settle;
    // One delta array per idle slice (requestIdleCallback where it exists, else a timer). Only the raw identity targets
    // (head_000 …, what Random face and Random character drive, ~12 MB as floats): semantic and emotion targets stay lazy.
    let warmHandle = 0;
    const hasIdle = typeof window.requestIdleCallback === "function"; // Safari only has it recently
    const idle = (fn: () => void) => (hasIdle ? window.requestIdleCallback(fn, { timeout: 500 }) : window.setTimeout(fn, 50));
    const warmNormals = () => {
      warmHandle = idle(() => {
        if (headMorph.t < 1) return warmNormals(); // not during the morph reveal: one slice froze a frame (50–120 ms)
        if (refresher.warmStep((t) => !t.startsWith("sem_") && !t.startsWith("emo_"))) warmNormals();
      });
    };
    // The semantic + emotion targets come in a second file once the head is on screen (lib/headExtra.ts).
    // After warmNormals: on a remount the head is already visible and onHeadVisible runs this at once.
    let abortExtra = () => {};
    const offVisible = onHeadVisible(() => {
      abortExtra = loadHeadExtra(meshes, refresher);
      warmNormals(); // idle time: the raw identity targets' deltas, ready before the first Random face
    });

    return () => {
      disposed = true;
      stopMorph();
      offPrecompile();
      window.clearTimeout(precompile);
      offVisible();
      stopMaps();
      stopTier();
      unbindSkin();
      offLimiter();
      window.clearTimeout(limiterTimer);
      limiter.attach(null);
      attachCapsWorker(null);
      if (hasIdle) window.cancelIdleCallback(warmHandle);
      else window.clearTimeout(warmHandle);
      abortExtra();
      unsubscribe();
      settleRef.current = null;
      morphs.unbindAll();
      refresher.clear();
      disposeMaterials();
      headRig.sway = headRig.leftEye = headRig.rightEye = null;
      skinRig.material = null;
      eyeRig.material = null;
      unmountHair();
      unmountAddons();
    };
  }, [scene, refresher, camera, canvas, gl, world]);

  // The eyes' lid shadow is measured in head space (lib/eyeShader.ts).
  const headNode = useMemo(() => scene.getObjectByName("head") ?? scene, [scene]);
  // The morph reveal's progress into the shaders (lib/morphShader.ts).
  useFrame((_, dt) => {
    if (headMorph.t < 1) morphFrame(headMorph.style, headMorph.t, dt);
    else morphUniforms.uMorph.value = 1;
    if (warmFrames.current > 0 && --warmFrames.current === 0 && !morphLookOn.current) setMorphLookAll(false);
    if (headMorph.t >= 1 && morphLookOn.current) {
      setMorphLookAll(false); // back to the plain programs (still cached)
      morphUniforms.uMorphSkin.value = 1; // (the last morph frame may stop just short; the warm-up draw needs 1)
      headMorph.yaw = headMorph.pitch = 0; // (the turn-in, likewise)
      performance.mark("morph-end");
      morphLookOn.current = false;
    }
  });
  useFrame(() => {
    drawEyesBack();
    updateEyeUniforms(headNode, headRig.leftEye, headRig.rightEye);
  });

  // First rendered frame = "head visible" (three allocates the morph texture here, not earlier).
  const marked = useRef(false);
  useFrame(() => {
    if (marked.current) return;
    marked.current = true;
    markHeadVisible();
  });

  // While the shape moves, keep the normals (light and shadow) and eye pivots following it (see LIVE_SETTLE).
  useFrame(() => {
    const l = live.current;
    const settle = settleRef.current;
    if (!settle || morphs.shapeVersion === l.seen) return;
    if (l.cost > LIVE_SETTLE.workerFromMs && refresher.canRefreshLater()) return settle(true); // a slow device
    const now = performance.now();
    if (now - l.last < l.cost * LIVE_SETTLE.budget) return; // over budget: try again next frame
    l.seen = morphs.shapeVersion;
    settle();
    l.last = now;
    l.cost = performance.now() - now;
  });

  return (
    <group ref={swayRef} position={NECK}>
      <primitive object={scene} position={NECK.clone().negate()} />
    </group>
  );
}
