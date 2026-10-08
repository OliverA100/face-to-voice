/**
 * /dev/hair-review — keep or cut hair styles (src/components/dev/HairReview.tsx). The review set lives in the gitignored
 * web/public/models/hair/review/.
 */
import type { Metadata } from "next";

import HairReview from "@/components/dev/HairReview";

export const metadata: Metadata = { title: "Hair review" };

export default function HairReviewPage() {
  return <HairReview />;
}
