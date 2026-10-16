"use client";

import { Canvas, type RootState } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useState } from "react";
import { type Mesh, type MeshStandardMaterial, type Object3D, PMREMGenerator } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

type Stats = { name: string; bytes: number; meshes: { name: string; vertices: number; triangles: number; texture: string }[] };

/** A neutral room as the environment light, as a generic glTF viewer would light it. */
function lightRoom({ gl, scene }: RootState) {
  const pmrem = new PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

export default function ModelPreview() {
  const [model, setModel] = useState<Object3D | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (file: File) => {
    setError(null);
    try {
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
      const meshes: Stats["meshes"] = [];
      gltf.scene.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        const map = (m.material as MeshStandardMaterial).map;
        meshes.push({
          name: m.name,
          vertices: m.geometry.attributes.position.count,
          triangles: (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3,
          texture: map?.image ? `${(map.image as { width: number }).width}²` : "",
        });
      });
      setModel(gltf.scene);
      setStats({ name: file.name, bytes: file.size, meshes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-page"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) void open(file);
      }}
    >
      <Canvas camera={{ fov: 24, position: [0, 0.3, 0.9], near: 0.01, far: 10 }} onCreated={lightRoom}>
        {model && <primitive object={model} />}
        <OrbitControls target={[0, 0.27, 0.05]} makeDefault />
      </Canvas>
      <div className="absolute left-4 top-4 max-w-sm rounded-lg bg-card/90 p-3 text-[13px] text-ink">
        <label className="block">
          <span className="text-label">character.glb </span>
          <input type="file" accept=".glb,model/gltf-binary" onChange={(e) => e.target.files?.[0] && void open(e.target.files[0])} />
        </label>
        {error && <p className="mt-2 text-red-700">{error}</p>}
        {stats && (
          <div className="mt-2 text-ink-3">
            <p>
              {stats.name}: {(stats.bytes / 1e6).toFixed(2)} MB, {stats.meshes.reduce((n, m) => n + m.triangles, 0).toLocaleString()} triangles
            </p>
            <ul className="mt-1">
              {stats.meshes.map((m, i) => (
                <li key={i}>
                  {m.name}: {m.vertices.toLocaleString()} v {m.texture}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
