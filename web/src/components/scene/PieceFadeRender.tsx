"use client";

/**
 * The render loop (priority 1, so R3F's own render is off). Normally one render, exactly what R3F would do.
 * While lib/pieceFade.ts has a batch, the leaving pieces live on layer 1 and the arriving ones on layer 2:
 *   - collecting (files still arriving): render the "before" image only (layers 0 + 1), the new pieces stay hidden;
 *   - running: render "before", copy the finished frame, render "after" (layers 0 + 2), then draw the copy over it at
 *     1 − t. Both images are final screen pixels, so t = 0 and t = 1 match a normal render exactly (no pop).
 * The "before" image also puts back the skin's scalp tint and stubble from when the batch opened (lib/pieceFade.ts).
 */
import { useFrame } from "@react-three/fiber";
import { Camera, FramebufferTexture, Mesh, type Object3D, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from "three";

import { pieceFade, pieceNodes } from "@/lib/pieceFade";
import { applySkinPieces } from "@/lib/skinShader";

const LEAVING = 1;
const ARRIVING = 2;

const onLayer = (nodes: readonly Object3D[], layer: number) => {
  for (const node of nodes) pieceNodes(node, (o) => o.layers.set(layer));
};

function makeOverlay() {
  const material = new ShaderMaterial({
    uniforms: { tFrame: { value: null }, uOpacity: { value: 1 } },
    vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    // The copy is already display pixels: no tone mapping, no colour conversion, just its opacity.
    fragmentShader: "uniform sampler2D tFrame;\nuniform float uOpacity;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = vec4( texture2D( tFrame, vUv ).rgb, uOpacity ); }",
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  return { scene, camera: new Camera(), material, frame: null as FramebufferTexture | null, size: new Vector2() };
}

/** The copy of the "before" frame and the quad that draws it (plain module state, made on the first fade). */
let overlay: ReturnType<typeof makeOverlay> | null = null;

export function PieceFadeRender() {
  useFrame(({ gl, scene, camera }) => {
    const { leaving, arriving, running, t, skinBefore } = pieceFade;
    if (!leaving.length && !arriving.length) {
      gl.render(scene, camera);
      return;
    }
    onLayer(leaving.map((l) => l.node), LEAVING); // every frame: cheap, and catches pieces that joined since
    onLayer(arriving, ARRIVING);
    const mask = camera.layers.mask;

    camera.layers.set(0);
    camera.layers.enable(LEAVING);
    const live = skinBefore && applySkinPieces(skinBefore);
    gl.render(scene, camera); // before
    if (live) applySkinPieces(live);
    if (running && t > 0) {
      overlay ??= makeOverlay();
      gl.getDrawingBufferSize(overlay.size);
      if (!overlay.frame || overlay.frame.image.width !== overlay.size.x || overlay.frame.image.height !== overlay.size.y) {
        overlay.frame?.dispose();
        overlay.frame = new FramebufferTexture(overlay.size.x, overlay.size.y);
        overlay.material.uniforms.tFrame.value = overlay.frame;
      }
      gl.copyFramebufferToTexture(overlay.frame);
      camera.layers.set(0);
      camera.layers.enable(ARRIVING);
      gl.render(scene, camera); // after
      overlay.material.uniforms.uOpacity.value = 1 - t;
      const autoClear = gl.autoClear;
      gl.autoClear = false;
      gl.render(overlay.scene, overlay.camera);
      gl.autoClear = autoClear;
    }
    camera.layers.mask = mask;
  }, 1);

  return null;
}
