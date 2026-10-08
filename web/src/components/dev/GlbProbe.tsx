"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { Lighting } from "@/components/scene/Lighting";

const MODEL_URL = "/models/head.glb";

/** Dotted divider between table rows (globals.css --line-dotted). */
const dotted = "divide-y divide-dotted divide-[#d9d5d0]";

type Stats = {
  firstFrameMs: number | null;
  maxVertexUniforms: number;
  maxArrayTextureLayers: number;
  maxTextureSize: number;
  meshes: { name: string; vertices: number; targets: number }[];
  morphBytes: number;
  fps: number;
  renderer: string;
};

/** The head itself. useGLTF(url, draco=false, meshopt=true). */
function Head({ target, weight, onLoaded }: { target: string | null; weight: number; onLoaded: (s: Partial<Stats>) => void }) {
  const gltf = useGLTF(MODEL_URL, false, true);
  const gl = useThree((s) => s.gl);

  // Collect every mesh, its target count and the GPU memory three.js will allocate for morphs
  // (one Float32 texture layer per target: vertices x 16 bytes x targets, positions only).
  const meshes = useMemo(() => {
    const list: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) list.push(o as THREE.Mesh);
    });
    return list;
  }, [gltf.scene]);

  useEffect(() => {
    let morphBytes = 0;
    const info = meshes.map((m) => {
      const targets = m.morphTargetInfluences?.length ?? 0;
      const vertices = m.geometry.attributes.position.count;
      morphBytes += vertices * 16 * targets;
      // Name comes from the named parent node (gltfpack drops mesh names, keeps node names).
      return { name: m.parent?.name || m.name, vertices, targets };
    });
    onLoaded({ meshes: info, morphBytes });
  }, [meshes, onLoaded]);

  // Apply the ?target=&w= weight to every mesh that has that target.
  /* eslint-disable react-hooks/immutability -- three.js meshes are mutable by design */
  useEffect(() => {
    for (const m of meshes) {
      if (!m.morphTargetDictionary || !m.morphTargetInfluences) continue;
      m.morphTargetInfluences.fill(0);
      if (target && target in m.morphTargetDictionary) {
        m.morphTargetInfluences[m.morphTargetDictionary[target]] = weight;
      }
    }
  }, [meshes, target, weight]);
  /* eslint-enable react-hooks/immutability */

  // First rendered frame = "head visible".
  const reported = useRef(false);
  useFrame(() => {
    if (reported.current) return;
    reported.current = true;
    onLoaded({ firstFrameMs: performance.now(), renderer: gl.capabilities.isWebGL2 ? "WebGL2" : "WebGL1" });
  });

  return <primitive object={gltf.scene} />;
}

function Probe({ onStats }: { onStats: (s: Partial<Stats>) => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const ctx = gl.getContext();
    onStats({
      maxVertexUniforms: gl.capabilities.maxVertexUniforms,
      maxArrayTextureLayers: ctx.getParameter((ctx as WebGL2RenderingContext).MAX_ARRAY_TEXTURE_LAYERS) as number,
      maxTextureSize: gl.capabilities.maxTextureSize,
    });
  }, [gl, onStats]);
  // Rolling fps.
  const frames = useRef(0);
  const last = useRef(0);
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - last.current >= 1000) {
      onStats({ fps: Math.round((frames.current * 1000) / (now - last.current)) });
      frames.current = 0;
      last.current = now;
    }
  });
  return null;
}

export default function GlbProbe() {
  const params = useSearchParams();
  const target = params.get("target");
  const weight = Number(params.get("w") ?? "1");
  const [stats, setStats] = useState<Partial<Stats>>({});
  // Stable callback: the effects below list it as a dependency, so a new function per render
  // would re-run them (and re-set state) forever.
  const merge = useCallback((s: Partial<Stats>) => setStats((prev) => ({ ...prev, ...s })), []);

  // Label → value rows for the card; "…" until the scene reports the number.
  const rows: [string, string][] = [
    ["First frame", stats.firstFrameMs ? `${Math.round(stats.firstFrameMs)} ms since navigation` : "…"],
    ["Frame rate", stats.fps === undefined ? "…" : `${stats.fps} fps${stats.renderer ? ` · ${stats.renderer}` : ""}`],
    ["GPU limits", `${stats.maxVertexUniforms ?? "?"} vertex uniform vectors · ${stats.maxArrayTextureLayers ?? "?"} array-texture layers · ${stats.maxTextureSize ?? "?"} max texture`],
    ["Morph memory", stats.morphBytes ? `${(stats.morphBytes / 1e6).toFixed(1)} MB (positions only)` : "…"],
    ["Active target", target ? `${target} = ${weight}` : "none"],
  ];

  return (
    <div className="fixed inset-0 bg-page text-ink">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0.27, 0.75], fov: 30, near: 0.05, far: 10 }}
        gl={{ antialias: true, alpha: false, stencil: false, powerPreference: "high-performance", toneMapping: THREE.NeutralToneMapping }}
      >
        <color attach="background" args={["#f5f3f1"]} /> {/* matches --surface in globals.css */}
        <Lighting /> {/* the app's lights, so the probe shows the head as the product does */}
        <Suspense fallback={null}>
          <Head target={target} weight={weight} onLoaded={merge} />
        </Suspense>
        <Probe onStats={merge} />
        <OrbitControls target={[0, 0.27, 0.05]} />
      </Canvas>

      {/* Floating white card with the numbers; pointer events pass through to the orbit controls. */}
      <section className="pointer-events-none absolute left-5 top-5 w-[min(92vw,440px)] rounded-2xl bg-card/95 p-5 shadow-float backdrop-blur" aria-label="Probe results">
        <p className="text-[13px] text-ink-3">/dev/glb</p>
        <h1 className="display mt-1 text-[24px]">head.glb probe</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">
          Add <code className="font-mono text-[12px] text-ink-2">?target=NAME&amp;w=-1..1</code> to the URL to set one morph weight.
        </p>

        <dl className={`mt-4 ${dotted} text-[13px]`}>
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="shrink-0 text-ink-3">{label}</dt>
              <dd className="text-right font-mono text-[12px] tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <table className="mt-4 w-full text-[13px]">
          <thead>
            <tr className="text-ink-3">
              <th className="pb-1.5 text-left font-normal">Mesh</th>
              <th className="pb-1.5 text-right font-normal">Vertices</th>
              <th className="pb-1.5 text-right font-normal">Targets</th>
            </tr>
          </thead>
          <tbody className={dotted}>
            {(stats.meshes ?? []).map((m, i) => (
              <tr key={`${m.name}-${i}`}>
                <td className="py-1 font-mono text-[12px] text-ink">{m.name}</td>
                <td className="py-1 text-right font-mono text-[12px] tabular-nums text-ink-2">{m.vertices}</td>
                <td className="py-1 text-right font-mono text-[12px] tabular-nums text-ink-2">{m.targets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

useGLTF.preload(MODEL_URL, false, true);
