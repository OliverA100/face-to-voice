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
  /** FTV_SAVED_VOICES=1, with FTV_MOCK_ELEVENLABS: the designs stay fake (no new voices, no voice credits), but Speak
   *  talks for real in the saved studio voice nearest the cast (STUDIO_VOICE_IDS), as a chat does in mock mode. */
  savedVoices: process.env.FTV_SAVED_VOICES === "1" && !deployed,
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
    profilesPerDay: num(process.env.DAILY_CAP_PROFILES, 100), // character profiles Claude writes (~0.7 ¢ each); a saved one is free
    talksPerDay: num(process.env.DAILY_CAP_TALKS, 20), // live conversations (~250 ElevenLabs credits each at 3 minutes)
  },
  /**
   * Pre-designed fallback voices used when the voice quota is spent: comma-separated "presentation-age:voiceId"
   * entries as scripts/studio-voices.ts prints them (e.g. "feminine-70s:abc…"); a bare id has no slot and is matched last.
   */
  studioVoices: (process.env.STUDIO_VOICE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(":");
    return i < 0 ? { slot: "", voiceId: s } : { slot: s.slice(0, i), voiceId: s.slice(i + 1) };
  }),
  /**
   * Live conversations (LiveKit). The browser only ever gets a short-lived room token minted with these; the agent
   * worker has its own copy of the keys. In development the local server (`livekit-server --dev`) uses devkey/secret.
   */
  livekit: {
    url: process.env.LIVEKIT_URL ?? "",
    apiKey: () => process.env.LIVEKIT_API_KEY ?? "",
    apiSecret: () => process.env.LIVEKIT_API_SECRET ?? "",
  },
  talk: {
    /** Invite-only until TALK_PUBLIC=1: comma-separated secret codes, passed as /?talk=<code>. */
    inviteCodes: (process.env.TALK_INVITE_CODES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    public: process.env.TALK_PUBLIC === "1",
    /** Conversations at once. Each holds an ElevenLabs dialogue session for its whole length (v4 Turbo). */
    maxConcurrent: num(process.env.MAX_CONCURRENT_TALKS, 5), // LiveKit Build's agent sessions; six ran at once on ElevenLabs Starter (2026-10-12)
    /** Hard length of a conversation; the agent enforces it too (and never runs longer than its own cap). */
    maxSeconds: num(process.env.TALK_MAX_SECONDS, 180),
  },
  /** Saved voices kept in the LRU pool: one more is saved before the oldest goes, so pool + 1 + studio voices must fit the plan (Starter: 3 + 1 + 6 = 10 slots). */
  voicePoolSize: num(process.env.VOICE_POOL_SIZE, 3),
};
