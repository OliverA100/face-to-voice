/** GET /api/limits: what this visitor has used of their own limits today. They reset at `resetAt` (midnight UTC). */
export interface LimitRow {
  id: string;
  label: string; // "voices picked"
  used: number;
  limit: number; // 10 a day on this browser (per network without the visitor cookie)
  network: { used: number; limit: number }; // the network's ceiling: everyone on it, together
}
export interface Limits {
  resetAt: string; // ISO time
  per: "browser" | "network"; // whose count `used` is: the browser's, or its network's when it keeps no cookies
  yours: LimitRow[]; // per visitor (lib/server/ratelimit.ts LIMITS)
}
