/**
 * Friendly, non-leaking error responses. The client renders `message`; `code` lets the UI pick
 * an icon or a retry hint. Upstream error bodies never reach the browser.
 */
import { z } from "zod";

export type ApiErrorCode = "bad_request" | "forbidden" | "visitor_limit" | "daily_cap" | "voice_quota" | "upstream" | "unavailable" | "busy" | "expired";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MESSAGES = {
  bad_request: "Invalid request.",
  visitor_limit: "You've reached today's limit for this step. Give it a break and try again later.",
  daily_cap: "Today's voice budget for this demo is used up. It resets at midnight UTC.",
  voice_quota: "All of today's fresh voices are spoken for, so here's the closest studio voice instead.",
  upstream: "The voice service didn't answer this time. Please try again in a moment.",
  unavailable: "This feature isn't configured on this deployment.",
  busy: "This voice is being set up for someone else right now. Try again in a moment.",
};

/** The response for anything a route handler throws: ApiErrors as they are, a body that fails validation as a 400, anything else as a 502. */
export function errorResponse(err: unknown): Response {
  if (err instanceof z.ZodError) return errorResponse(new ApiError("bad_request", MESSAGES.bad_request, 400));
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  console.error("[api] unexpected:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  return Response.json({ error: "upstream", message: MESSAGES.upstream }, { status: 502, headers: { "cache-control": "no-store" } });
}

/** The request body parsed as JSON. A body that isn't JSON is the client's mistake (400), not a failure upstream. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("bad_request", MESSAGES.bad_request, 400);
  }
}
