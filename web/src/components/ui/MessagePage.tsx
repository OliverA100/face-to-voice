import type { ReactNode } from "react";

import { SiteHeader } from "@/components/ui/SiteHeader";
import { LoaderSphere } from "@/components/ui/loader/LoaderSphere";

/**
 * A whole page with one message on the head's grey card (the 404, the error page): the sphere, a title and a way on.
 */
export function MessagePage({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full flex-col bg-page pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-ink">
      <SiteHeader />
      {/* The card fills the page under the header with the builder's gutters, like the head's card the loader sits on. */}
      <main className="flex flex-1 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-5 lg:pb-5">
        <div className="flex flex-1 flex-col items-center justify-center gap-6 rounded-card bg-surface px-4 py-10 shadow-hairline">
          <LoaderSphere size="min(168px, 36vw)" />
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="font-mono text-meta text-ink-3">{eyebrow}</p>
            <h1 className="display text-title md:text-title-lg">{title}</h1>
            <p className="max-w-[36ch] text-body text-ink-3">{text}</p>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
