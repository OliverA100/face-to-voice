import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// The visitor cookie (visitor.ts) and the proxy that sets it (src/proxy.ts), with the real next/server.
const env = vi.hoisted(() => ({ hasRedis: false, isDeployed: false, rateLimitSalt: "test-salt", caps: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/env", () => ({ env }));

import { LIMITS } from "../ratelimit";
import { VISITOR_COOKIE, browserId, networkId, networkOf, newVisitorCookie, readVisitorCookie, visitorId } from "../visitor";
import { config, proxy } from "@/proxy";

const request = (ip: string, cookie?: string) =>
  new Request("http://localhost/api/limits", { headers: { "x-real-ip": ip, ...(cookie ? { cookie: `theme=dark; ${VISITOR_COOKIE}=${cookie}` } : {}) } });
const setCookie = (r: Response) => r.headers.get("set-cookie") ?? "";

describe("the visitor cookie", () => {
  it("holds a random id signed by this server: two cookies, two ids", () => {
    const a = newVisitorCookie()!;
    const b = newVisitorCookie()!;
    expect(a).toMatch(/^[\w-]{24}\.[\w-]{22}$/);
    expect(readVisitorCookie(a)).toBe(a.split(".")[0]);
    expect(readVisitorCookie(b)).not.toBe(readVisitorCookie(a));
  });

  it("refuses a cookie this server didn't sign: edited, made up, signed with another salt, or none", () => {
    const good = newVisitorCookie()!;
    const [id, sig] = good.split(".");
    expect(readVisitorCookie(`${id.slice(0, -1)}${id.at(-1) === "A" ? "B" : "A"}.${sig}`)).toBeNull(); // someone else's id
    expect(readVisitorCookie(`${id}.${sig.slice(0, -1)}`)).toBeNull();
    expect(readVisitorCookie(`${good}.extra`)).toBeNull();
    expect(readVisitorCookie("hello")).toBeNull();
    expect(readVisitorCookie(undefined)).toBeNull();
    env.rateLimitSalt = "another-salt";
    expect(readVisitorCookie(good)).toBeNull();
    env.rateLimitSalt = "";
    expect(newVisitorCookie()).toBeNull();
    expect(readVisitorCookie(good)).toBeNull();
    env.rateLimitSalt = "test-salt";
  });

  it("is the visitor: two browsers on one network are two visitors; without a cookie the network is", () => {
    const a = newVisitorCookie()!;
    const b = newVisitorCookie()!;
    expect(visitorId(request("1.1.1.1", a))).toBe(browserId(request("1.1.1.1", a)));
    expect(visitorId(request("1.1.1.1", a))).toBe(visitorId(request("9.9.9.9", a))); // a phone that changes networks keeps its things
    expect(visitorId(request("1.1.1.1", a))).not.toBe(visitorId(request("1.1.1.1", b)));
    expect(browserId(request("1.1.1.1"))).toBeNull();
    expect(visitorId(request("1.1.1.1"))).toBe(networkId(request("1.1.1.1")));
    expect(visitorId(request("1.1.1.1", "made.up"))).toBe(networkId(request("1.1.1.1")));
  });

  it("refuses without a salt (503), like the IP hashes did", () => {
    env.rateLimitSalt = "";
    expect(() => visitorId(request("1.1.1.1"))).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    expect(() => networkId(request("1.1.1.1"))).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    env.rateLimitSalt = "test-salt";
  });
});

describe("the network", () => {
  it("is an IPv4 address whole, and an IPv6 address by its /64", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64"); // case and leading zeros
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(networkOf("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(networkOf("::ffff:203.0.113.7")).toBe("203.0.113.7"); // IPv4 written as IPv6
    expect(networkOf("64:ff9b:1:2:3:4:1.2.3.4")).toBe("64:ff9b:1:2::/64"); // an IPv4 tail
    expect(networkOf("not an ip")).toBe("not an ip");
  });

  it("hashes the network: addresses in one /64 are one network, another /64 or IPv4 address is another", () => {
    const net = (ip: string) => networkId(request(ip));
    expect(net("2001:db8:1:2::1")).toBe(net("2001:db8:1:2:ffff::42")); // the same phone, a rotated address
    expect(net("2001:db8:1:2::1")).not.toBe(net("2001:db8:1:3::1"));
    expect(net("1.1.1.1")).not.toBe(net("1.1.1.2"));
    expect(net("1.1.1.1")).not.toContain("1.1.1.1");
  });
});

describe("src/proxy.ts", () => {
  const call = (cookie?: string) => proxy(new NextRequest("http://localhost/api/limits", { headers: cookie ? { cookie: `${VISITOR_COOKIE}=${cookie}` } : {} }));

  it("gives a browser without a cookie a new one (HttpOnly, Lax, a year), and the route this request already sees it", () => {
    const res = call();
    const value = /ftv_visitor=([^;]+)/.exec(setCookie(res))?.[1];
    expect(readVisitorCookie(value)).not.toBeNull();
    expect(setCookie(res)).toMatch(/HttpOnly/i);
    expect(setCookie(res)).toMatch(/SameSite=lax/i);
    expect(setCookie(res)).toMatch(/Path=\//);
    expect(setCookie(res)).toMatch(/Max-Age=31536000/);
    expect(setCookie(res)).not.toMatch(/Secure/i); // plain http in development
    // NextResponse.next({ request }) passes the rewritten Cookie header to the route this way
    expect(res.headers.get("x-middleware-request-cookie")).toContain(`${VISITOR_COOKIE}=${value}`);
  });

  it("is Secure when deployed", () => {
    env.isDeployed = true;
    expect(setCookie(call())).toMatch(/Secure/i);
    env.isDeployed = false;
  });

  it("leaves a valid cookie alone, and replaces one it didn't sign", () => {
    const good = newVisitorCookie()!;
    expect(setCookie(call(good))).toBe("");
    const replaced = /ftv_visitor=([^;]+)/.exec(setCookie(call(`${good}x`)))?.[1];
    expect(readVisitorCookie(replaced)).not.toBeNull();
    expect(replaced).not.toBe(good);
  });

  it("runs on every route that asks who the visitor is, and not on pages or Speak", () => {
    const limited = Object.keys(LIMITS).join("|");
    const asks = new RegExp(`visitorId\\(|visitorUsage\\(|checkVisitorLimit\\(request, "(${limited})"\\)`);
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === "route.ts" && asks.test(readFileSync(path, "utf8"))) routes.push(path.slice(path.indexOf("/api/")).replace(/\/route\.ts$/, ""));
      }
    };
    walk(join(process.cwd(), "src/app/api"));
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const url of routes) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    for (const url of ["/", "/api/voice/speak", "/api/usage", "/_next/static/chunks/main.js"]) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
  });
});
