/**
 * /dev/model — the exported character.glb on its own: a plain GLTFLoader, orbit controls and a neutral room light, none
 * of the app's shaders. Pick or drop a character.glb (from a "Download character" zip).
 */
import type { Metadata } from "next";

import ModelPreviewLazy from "@/components/dev/ModelPreviewLazy";

export const metadata: Metadata = { title: "Model preview" };

export default function ModelPreviewPage() {
  return <ModelPreviewLazy />;
}
