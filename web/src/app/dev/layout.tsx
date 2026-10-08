/**
 * /dev/*: development tools (the viseme tuner, the hair review, a glb probe). Development only: a production build
 * answers every /dev route with 404.
 */
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
