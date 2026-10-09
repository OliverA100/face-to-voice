/** Fits glasses to the skin off the main thread (lib/glassesSolve.ts; lib/glassesFit.ts asks). One prepared frame per id. */
import { type FitLimits, type FitResult, prepareSolve, type Solve, solveFit, type SolveInput } from "./glassesSolve";

export type ToGlassesWorker =
  | { type: "prepare"; id: number; input: SolveInput }
  | { type: "fit"; id: number; req: number; current: Float32Array; skinMatrix: number[]; pts: Float32Array; limits: FitLimits }
  | { type: "drop"; id: number };
export type FromGlassesWorker = ({ req: number } & FitResult) | { req: number; error: string };

const solves = new Map<number, Solve>();

self.onmessage = (e: MessageEvent<ToGlassesWorker>) => {
  const m = e.data;
  if (m.type === "prepare") solves.set(m.id, prepareSolve(m.input));
  else if (m.type === "drop") solves.delete(m.id);
  else {
    const solve = solves.get(m.id);
    const reply: FromGlassesWorker = solve ? { req: m.req, ...solveFit(solve, m.current, m.skinMatrix, m.pts, m.limits) } : { req: m.req, error: "not prepared" };
    (self as unknown as Worker).postMessage(reply);
  }
};
