"use client";

/** Anything that crashes the page outside the 3D scene (which has its own message): the 404's card, and a retry. */
import { useEffect } from "react";

import { MessagePage } from "@/components/ui/MessagePage";

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => console.error("[page]", error), [error]);
  return (
    <MessagePage eyebrow="Error" title="Something went wrong" text="The page hit a problem it couldn't recover from. Try again, or reload the page.">
      <button type="button" onClick={retry} className="pill-primary mt-3 h-10">
        Try again
      </button>
    </MessagePage>
  );
}
