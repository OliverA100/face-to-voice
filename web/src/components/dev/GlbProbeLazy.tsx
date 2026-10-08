"use client";

/**
 * Client-side wrapper: `ssr: false` dynamic imports are only allowed in Client Components in
 * Next 16, and three.js must never run on the server anyway.
 */
import dynamic from "next/dynamic";
import { Suspense } from "react";

const GlbProbe = dynamic(() => import("@/components/dev/GlbProbe"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-page p-5 text-[13px] text-ink-3">Loading probe…</div>,
});

export default function GlbProbeLazy() {
  return (
    <Suspense fallback={null}>
      <GlbProbe />
    </Suspense>
  );
}
