/** GET /api/limits: what this visitor and the whole site have used today. Everything resets at `resetAt` (midnight UTC). */
export interface LimitRow {
  id: string;
  label: string; // "voice searches"
  used: number;
  limit: number;
}
export interface Limits {
  resetAt: string; // ISO time
  yours: LimitRow[]; // per visitor (lib/server/ratelimit.ts LIMITS)
  site: LimitRow[]; // shared by every visitor (the daily caps)
}
