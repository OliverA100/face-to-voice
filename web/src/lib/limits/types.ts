/** GET /api/limits: what this visitor has used of their own limits today. They reset at `resetAt` (midnight UTC). */
export interface LimitRow {
  id: string;
  label: string; // "voices picked"
  used: number;
  limit: number;
}
export interface Limits {
  resetAt: string; // ISO time
  yours: LimitRow[]; // per visitor (lib/server/ratelimit.ts LIMITS)
}
