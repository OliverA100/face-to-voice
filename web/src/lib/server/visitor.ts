/**
 * Who a visitor is, without accounts. Two ids, both meaningless outside this site:
 *
 *   browser   a random id in a signed first-party cookie (VISITOR_COOKIE), set by src/proxy.ts on the first API call
 *             that needs it. One per browser: people sharing a network (a phone carrier, office or conference Wi-Fi)
 *             each get their own allowance, castings, Recast characters and chats. Clearing the cookie makes a new one.
 *   network   the IP, HMAC'd with RATE_LIMIT_SALT, IPv6 by its /64 (one home or phone gets a whole /64 and can rotate
 *             through it). The ceiling that stops a cookie-clearing loop; raw IPs never touch Redis or logs.
 *
 * The cookie only holds the random id and its signature: nothing about the person, used for limits and to keep their
 * own castings and characters apart from other people's. Signed with a key derived from RATE_LIMIT_SALT, so nobody
 * can choose an id (someone else's): an id this server didn't make is replaced by a new one.
 */
import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";

export const VISITOR_COOKIE = "ftv_visitor";
/** A year: the id outlives any limit or cache it scopes, and stays under Chrome's 400-day cap on cookie lifetimes. */
export const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** The cookie's signing key: derived from RATE_LIMIT_SALT, so it differs from the key that hashes IPs. Empty without a salt. */
const signingKey = () => (env.rateLimitSalt ? createHmac("sha256", env.rateLimitSalt).update("ftv visitor cookie").digest() : null);
const sign = (key: Buffer, id: string) => createHmac("sha256", key).update(id).digest("base64url").slice(0, 22); // 132 bits

/** A new cookie value, "<id>.<signature>": 18 random bytes (24 characters, like the old IP hashes), or null without a salt. */
export function newVisitorCookie(): string | null {
  const key = signingKey();
  if (!key) return null;
  const id = randomBytes(18).toString("base64url");
  return `${id}.${sign(key, id)}`;
}

/** The browser id in a cookie value, or null when it is missing, malformed or not signed by this server. */
export function readVisitorCookie(value: string | undefined): string | null {
  const key = signingKey();
  const [id, sig, extra] = value?.split(".") ?? [];
  if (!key || !id || !sig || extra !== undefined || !/^[\w-]{24}$/.test(id)) return null;
  const want = Buffer.from(sign(key, id));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

/** This request's browser id (null without a valid cookie: blocked cookies, or a route the proxy doesn't run on). */
export function browserId(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  // A browser sends one ftv_visitor; read it by hand, so this works on a plain Request (route tests) as on a NextRequest
  const value = cookies.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${VISITOR_COOKIE}=`))?.slice(VISITOR_COOKIE.length + 1);
  return readVisitorCookie(value);
}

/** The request's IP as Vercel reports it (x-real-ip; the first x-forwarded-for hop elsewhere). */
const clientIp = (request: Request) => request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";

/**
 * The network an address belongs to: an IPv4 address whole (a NAT shares one), an IPv6 address by its first 64 bits
 * ("2001:db8:1:2::/64"). An IPv4 address written as IPv6 (::ffff:1.2.3.4) counts as the IPv4 address. Anything
 * unparseable is kept as it is, so it still has a bucket of its own.
 */
export function networkOf(ip: string): string {
  const bare = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase(); // [addr], and a zone like %en0
  if (isIPv4(bare) || !isIPv6(bare)) return bare;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  // Expand "::" into the zero groups it stands for (an embedded IPv4 tail fills the last two), keep the first four
  const [head, tail = ""] = bare.split("::");
  const groups = (s: string) => (s ? s.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const left = groups(head);
  const right = bare.includes("::") ? groups(tail) : [];
  const all = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** The request's network, HMAC'd with RATE_LIMIT_SALT: stable per network, never reversible to the IP. */
export function networkId(request: Request): string {
  if (!env.rateLimitSalt) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  return createHmac("sha256", env.rateLimitSalt).update(networkOf(clientIp(request))).digest("base64url").slice(0, 24);
}

/**
 * Who this request is for their own things (castings, Recast characters, chats): the browser id, or the network id
 * when the browser has no valid cookie (then everyone on that network shares them, as everyone did before the cookie).
 */
export function visitorId(request: Request): string {
  if (!env.rateLimitSalt) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  return browserId(request) ?? networkId(request);
}
