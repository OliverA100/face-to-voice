"use client";

/**
 * If WebGL fails (old device, disabled GPU, a context lost for good: Scene.tsx reports that through lib/sceneFailure)
 * show a plain message instead of a blank canvas. If head.glb couldn't be downloaded (offline, a server error), say so
 * and offer a retry: a fresh scene downloads it again (lib/headLoad.ts headBytes forgets a failed download).
 */
import { Component, type ReactNode } from "react";

import { HeadDownloadError } from "@/lib/headLoad";
import { onSceneFailure, type SceneFailure, setSceneFailure } from "@/lib/sceneFailure";

type State = { failed: SceneFailure | null };

export class SceneErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: error instanceof HeadDownloadError ? "download" : "webgl" };
  }

  private off = () => {};

  componentDidMount(): void {
    this.off = onSceneFailure((failed) => failed && this.setState({ failed }));
  }

  componentWillUnmount(): void {
    this.off();
  }

  componentDidCatch(error: Error): void {
    console.error("[scene]", error.message);
    setSceneFailure(error instanceof HeadDownloadError ? "download" : "webgl");
  }

  retry = (): void => {
    setSceneFailure(null);
    this.setState({ failed: null });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.state.failed === "download") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface p-8 text-center text-body text-ink-2">
          <p role="alert" className="max-w-sm">The 3D head couldn&apos;t download. Check your connection and try again.</p>
          <button type="button" className="pill-secondary h-9" onClick={this.retry}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-surface p-8 text-center text-body text-ink-2">
        <p role="alert" className="max-w-sm">
          The 3D head couldn&apos;t start in this browser (it needs WebGL 2). Try a current Chrome, Safari or Firefox, or another device.
        </p>
      </div>
    );
  }
}
