import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// A head.glb that can't be downloaded (offline, a server error) is not a WebGL problem: the scene says so and offers
// a retry, which downloads it again. A real WebGL failure keeps its message.
import { headBytes } from "@/lib/headLoad";
import { SceneErrorBoundary } from "../SceneErrorBoundary";

afterEach(() => vi.unstubAllGlobals());

/** What the boundary shows after catching `error`. */
function shown(error: unknown): string {
  const boundary = new SceneErrorBoundary({ children: null });
  boundary.state = SceneErrorBoundary.getDerivedStateFromError(error);
  return renderToStaticMarkup(createElement("div", null, boundary.render()));
}

describe("the scene's error message", () => {
  it("offers a retry when head.glb couldn't be downloaded, and the retry downloads it again", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);
    const error = await headBytes().catch((e: unknown) => e);
    const html = shown(error);
    expect(html).toContain("Try again");
    expect(html).not.toContain("WebGL");

    fetch.mockImplementation(() => Promise.resolve(new Response(new ArrayBuffer(4))) as never);
    vi.stubGlobal("location", { href: "http://localhost/" });
    await expect(headBytes()).resolves.toBeInstanceOf(ArrayBuffer); // a failed download isn't remembered
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the WebGL message for anything else", () => {
    const html = shown(new Error("Error creating WebGL context."));
    expect(html).toContain("it needs WebGL 2");
    expect(html).not.toContain("Try again");
  });
});
