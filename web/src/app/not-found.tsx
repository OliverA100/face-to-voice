/**
 * The 404 page, for any address the app doesn't have (and any notFound()): the site's header, the loader's sphere
 * swinging between blob and bubble, and the way back to the builder. Rendered without streaming, so the response is a
 * real 404; Next adds robots noindex to it.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { SiteHeader } from "@/components/ui/SiteHeader";
import { LoaderSphere } from "@/components/ui/loader/LoaderSphere";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="flex min-h-dvh w-full flex-col bg-page pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-ink">
      <SiteHeader />
      {/* The card fills the page under the header with the builder's gutters, like the head's card the loader sits on. */}
      <main className="flex flex-1 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-5 lg:pb-5">
        <div className="flex flex-1 flex-col items-center justify-center gap-6 rounded-card bg-surface px-4 py-10 shadow-hairline">
          <LoaderSphere size="min(168px, 36vw)" />
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="font-mono text-meta text-ink-3">404</p>
            <h1 className="display text-title md:text-[28px]">This page has no face.</h1>
            <p className="max-w-[36ch] text-body text-ink-3">We looked everywhere. Shape one instead, and hear what it sounds like.</p>
            {/* No prefetch: it would download the builder's ~360 KB of JS on every 404, clicked or not. */}
            <Link href="/" prefetch={false} className="pill-primary mt-3 h-10">
              Shape a face
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
