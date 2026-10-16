/**
 * Gives each browser its visitor cookie (lib/server/visitor.ts) on the first API call that needs one. A browser with a
 * valid cookie passes straight through; one without (a first visit, a cleared or tampered cookie) gets a new id, set
 * on the response for next time and passed to the route now, so this very request is already that browser.
 *
 * Runs only on the routes that ask who the visitor is (config.matcher): not on pages, so nobody gets a cookie just
 * for looking, and not on Speak, whose first audio shouldn't wait for a proxy.
 */
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/server/env";
import { VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE, newVisitorCookie, readVisitorCookie } from "@/lib/server/visitor";

export function proxy(request: NextRequest) {
  if (readVisitorCookie(request.cookies.get(VISITOR_COOKIE)?.value)) return NextResponse.next();
  const value = newVisitorCookie();
  if (!value) return NextResponse.next(); // no RATE_LIMIT_SALT: the route refuses (503) on its own
  request.cookies.set(VISITOR_COOKIE, value); // rewrites the request's Cookie header, which the route reads
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(VISITOR_COOKIE, value, {
    httpOnly: true, // the page's scripts never need it
    secure: env.isDeployed, // https only on Vercel; plain http works in local development
    sameSite: "lax",
    path: "/",
    maxAge: VISITOR_COOKIE_MAX_AGE,
  });
  return response;
}

export const config = {
  // Every route that calls visitorId, checkVisitorLimit on a limited step or visitorUsage (a test checks this list)
  matcher: ["/api/voice/design", "/api/voice/select", "/api/voice/recast", "/api/character/profile", "/api/talk/token", "/api/limits"],
};
