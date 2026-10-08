/**
 * Server-only environment access. Import this only from route handlers and lib/server modules.
 * Nothing here is ever sent to the browser. API keys are read at the call that needs them, and a
 * missing optional service (Redis, Blob) switches to the in-memory dev fallbacks instead of failing.
 */
import "server-only";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
};

/** Running on Vercel: Production and every Preview deployment (VERCEL is set on both, never under `next dev`). */
const deployed = !!process.env.VERCEL;

export const env = {
  isDeployed: deployed,
  anthropicKey: () => process.env.ANTHROPIC_API_KEY ?? "",
  elevenLabsKey: () => process.env.ELEVENLABS_API_KEY ?? "",
  // Both mocks are development only and ignored on any deployment, so a stray flag can never let fake castings design
  // real voices into the shared cache.
  /** FTV_MOCK_ELEVENLABS=1: tone previews and a synthetic speech stream, no ElevenLabs calls. */
  mockElevenLabs: process.env.FTV_MOCK_ELEVENLABS === "1" && !deployed,
  /** FTV_MOCK_CLAUDE=1: a fixed casting built from the request (lib/server/mockCasting.ts), no Anthropic calls. */
  mockClaude: process.env.FTV_MOCK_CLAUDE === "1" && !deployed,
  claudeModel: process.env.CLAUDE_MODEL_PRODUCTION || "claude-sonnet-5",
  hasRedis: !!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) && !!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
  hasBlob: !!process.env.BLOB_READ_WRITE_TOKEN,
  /** Empty when deployed without RATE_LIMIT_SALT: the paid routes then refuse (ratelimit.ts requireStore) rather than hash IPs with a public salt. */
  rateLimitSalt: process.env.RATE_LIMIT_SALT || (deployed ? "" : "dev-only-salt"),
  usageAdminToken: process.env.USAGE_ADMIN_TOKEN ?? "",
  caps: {
    castingsPerDay: num(process.env.DAILY_CAP_CASTINGS, 200), // Claude castings (~1.1 ¢ each); cached faces are free
    designsPerDay: num(process.env.DAILY_CAP_DESIGNS, 20),
    savesPerDay: num(process.env.DAILY_CAP_SAVES, 10),
    speakCharsPerDay: num(process.env.DAILY_CAP_SPEAK_CHARS, 20_000),
  },
  /**
   * Pre-designed fallback voices used when the voice quota is spent: comma-separated "presentation-age:voiceId"
   * entries as scripts/studio-voices.ts prints them (e.g. "feminine-70s:abc…"); a bare id has no slot and is matched last.
   */
  studioVoices: (process.env.STUDIO_VOICE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(":");
    return i < 0 ? { slot: "", voiceId: s } : { slot: s.slice(0, i), voiceId: s.slice(i + 1) };
  }),
  /** Saved voices kept in the LRU pool: one more is saved before the oldest goes, so pool + 1 + studio voices must fit the plan (Starter: 3 + 1 + 6 = 10 slots). */
  voicePoolSize: num(process.env.VOICE_POOL_SIZE, 3),
};
