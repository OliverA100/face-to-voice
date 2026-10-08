/**
 * /dev/visemes — tune the mouth shapes. Pick a viseme (or blink/jaw role), move the expression
 * sliders until it looks right, then copy the JSON into web/src/data/visemes.json.
 */
import type { Metadata } from "next";

import VisemeTunerLazy from "@/components/dev/VisemeTunerLazy";

export const metadata: Metadata = { title: "Viseme tuner" };

export default function VisemeTunerPage() {
  return <VisemeTunerLazy />;
}
