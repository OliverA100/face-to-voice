/**
 * /dev/glb — a probe for the exported head, independent of the app's own loading code.
 *
 * Loads web/public/models/head.glb through drei's meshopt decoder, prints the GPU limits that
 * matter for morph targets, the time to the first rendered frame, and every mesh's target
 * count. Query params:  ?target=lower_face_region_000&w=1   sets one morph weight (-1..1).
 */
import type { Metadata } from "next";

import GlbProbeLazy from "@/components/dev/GlbProbeLazy";

export const metadata: Metadata = { title: "GLB probe" };

export default function GlbProbePage() {
  return <GlbProbeLazy />;
}
