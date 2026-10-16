"use client";

/** Client-side wrapper (as GlbProbeLazy): three.js never runs on the server. */
import dynamic from "next/dynamic";

const ModelPreview = dynamic(() => import("@/components/dev/ModelPreview"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-page p-5 text-[13px] text-ink-3">Loading preview…</div>,
});

export default function ModelPreviewLazy() {
  return <ModelPreview />;
}
