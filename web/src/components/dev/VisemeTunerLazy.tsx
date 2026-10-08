"use client";

/**
 * Client-side wrapper: `ssr: false` dynamic imports are only allowed in Client Components in
 * Next 16, and three.js must never run on the server anyway.
 */
import dynamic from "next/dynamic";

const VisemeTuner = dynamic(() => import("@/components/dev/VisemeTuner"), { ssr: false, loading: () => null });

export default function VisemeTunerLazy() {
  return <VisemeTuner />;
}
