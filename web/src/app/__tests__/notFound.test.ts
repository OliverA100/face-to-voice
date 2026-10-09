import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteHeader } from "@/components/ui/SiteHeader";

import NotFound, { metadata } from "../not-found";

const APP = join(import.meta.dirname, "..");

describe("404 page", () => {
  const html = renderToStaticMarkup(createElement(NotFound));

  it("says the page wasn't found: the title, one h1, the way back to the builder", () => {
    expect(metadata.title).toBe("Page not found"); // the layout's template adds " · Face to Voice"
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>This page has no face\.<\/h1>/);
    const button = html.match(/<a [^>]*>Shape a face<\/a>/)![0];
    expect(button).toContain('href="/"');
    expect(button).toMatch(/class="pill-primary /);
  });

  it("links the header's name home (the builder's h1 is not repeated)", () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)![0];
    expect(header).not.toContain("<h1");
    expect(header).toMatch(/<a [^>]*href="\/"[^>]*>[\s\S]*Face to Voice<\/a>/);
    // …while on the builder the same header's name is the page's h1
    expect(renderToStaticMarkup(createElement(SiteHeader, { home: true }))).toMatch(/<h1[^>]*>[\s\S]*Face to Voice<\/h1>/);
  });

  it("hides the sphere from screen readers and server-renders its poster (no JS, no WebGL, reduced motion)", () => {
    const sphere = html.match(/<div aria-hidden="true"[^>]*>[\s\S]*?data-chrome-still[\s\S]*?var\(--chrome-poster-image/);
    expect(sphere).not.toBeNull();
    expect(html).not.toContain("<canvas"); // the live canvas only comes from the client
  });

  // A real 404 status needs the not-found page rendered before the response starts: a loading.tsx at the root would
  // stream the page as a 200 (with noindex) instead. Checked for real with `next build && next start` (curl -I).
  it("isn't streamed: no loading.tsx at the root", () => {
    expect(existsSync(join(APP, "not-found.tsx"))).toBe(true);
    expect(readdirSync(APP)).not.toContain("loading.tsx");
  });
});
