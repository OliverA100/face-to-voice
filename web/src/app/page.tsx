import type { Metadata } from "next";

import { FaceBuilder } from "@/components/FaceBuilder";

// One address for the builder, whatever its query (?talk= invites, ?debug, ?perf) or host (the deployment's own URL).
export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Home() {
  return <FaceBuilder />;
}
