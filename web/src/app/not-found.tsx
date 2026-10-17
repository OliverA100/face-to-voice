/**
 * The 404 page, for any address the app doesn't have (and any notFound()): the site's header, the loader's sphere
 * swinging between blob and bubble, and the way back to the builder. Rendered without streaming, so the response is a
 * real 404; Next adds robots noindex to it.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { MessagePage } from "@/components/ui/MessagePage";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <MessagePage eyebrow="404" title="This page has no face." text="We looked everywhere. Shape one instead, and hear what it sounds like.">
      {/* No prefetch: it would download the builder's ~360 KB of JS on every 404, clicked or not. */}
      <Link href="/" prefetch={false} className="pill-primary mt-3 h-10">
        Shape a face
      </Link>
    </MessagePage>
  );
}
