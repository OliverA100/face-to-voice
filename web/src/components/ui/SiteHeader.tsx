import Link from "next/link";

import { LogoOrb } from "@/components/ui/LogoOrb";

/** The source repository; the top bar links to it. */
const REPO_URL = "https://github.com/OliverA100/face-to-voice";

const NAME = "flex items-center gap-2 whitespace-nowrap text-input font-medium tracking-[-0.01em]";

/**
 * The top bar: the logo and name, the tagline (from lg), and the links. Shared by the builder and the 404 page.
 * `home`: on the builder the name is the page's h1; anywhere else it links home and the page has its own h1.
 * Below lg it sticks to the top (the builder's page scrolls under it, FaceBuilder.tsx).
 */
export function SiteHeader({ home = false }: { home?: boolean }) {
  const name = (
    <>
      <LogoOrb size={18} />
      Face to Voice
    </>
  );
  return (
    <header className="sticky top-0 z-20 box-content flex h-14 shrink-0 items-center justify-between bg-page px-3 pt-[env(safe-area-inset-top)] md:h-16 lg:static lg:px-5">
      <div className="flex items-center gap-3">
        {home ? (
          <h1 className={NAME}>{name}</h1>
        ) : (
          // No prefetch: the builder is ~360 KB of JS, too much to fetch for a visitor who may not click (the 404)
          <Link href="/" prefetch={false} className={NAME}>
            {name}
          </Link>
        )}
        <p className="hidden text-label text-ink-3 lg:block">Every face suggests a voice. Shape one and hear it.</p>
      </div>
      <nav className="flex items-center gap-2" aria-label="Links">
        <a href="https://elevenlabs.io" target="_blank" rel="noreferrer" className="pill-secondary hidden h-9 sm:inline-flex">
          Built with ElevenLabs
          <span aria-hidden className="-ml-1 text-ink-3">
            ↗
          </span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="pill-primary h-8 px-3 text-label sm:h-9 sm:px-4 sm:text-body">
          GitHub
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </nav>
    </header>
  );
}
