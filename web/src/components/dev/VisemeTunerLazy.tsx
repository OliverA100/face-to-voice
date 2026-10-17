"use client";

/** Client-side wrapper (as GlbProbeLazy): three.js never runs on the server. */
import dynamic from "next/dynamic";

const VisemeTuner = dynamic(() => import("@/components/dev/VisemeTuner"), { ssr: false, loading: () => null });

export default function VisemeTunerLazy() {
  return <VisemeTuner />;
}
