# Deploying Face to Voice on Vercel

Everything below is a one-time setup. The app runs without steps 3–5 in development
(in-memory limits, no bot check); in production the paid routes refuse to run until Redis
is configured, so nobody can spend your credits before the caps exist.

## 1. Vercel project

- Import the GitHub repo. Set **Root Directory** to `web`. Framework preset: Next.js.
  Node.js 22.18 or newer (the default is fine).
- Fluid compute is on by default (keep it on: the design and select routes declare `maxDuration = 120`, which needs it;
  speak declares 60).

## 2. Environment variables (Project → Settings → Environment Variables)

Mark every key as **Sensitive** (`vercel env add NAME production`). On any Vercel deployment, production or preview,
the paid routes refuse to run until Upstash Redis and `RATE_LIMIT_SALT` are set, so nobody can spend your credits
before the limits exist.

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key. In the Console set an organisation spend limit (Settings → Billing → Spend limits). |
| `ELEVENLABS_API_KEY` | ElevenLabs key restricted to: Text to Speech, Voices (write), Voice Generation, User. Give the key its own **credit quota** in the ElevenLabs dashboard — that is the hard stop no app cap can replace. |
| `CLAUDE_MODEL_PRODUCTION` | `claude-sonnet-5` |
| `RATE_LIMIT_SALT` | required: any long random string (`openssl rand -hex 32`); visitors are counted by an HMAC of their IP with it |
| `USAGE_ADMIN_TOKEN` | another random string; `curl -H "Authorization: Bearer …" https://<site>/api/usage` shows today's caps and quotas |
| `DAILY_CAP_CASTINGS` / `DAILY_CAP_DESIGNS` / `DAILY_CAP_SAVES` / `DAILY_CAP_SPEAK_CHARS` | global daily caps; the defaults are 200 Claude castings / 20 designs / 10 saves / 20000 spoken characters; the app also stops saving 1 short of the plan's monthly add/edits |
| `VOICE_POOL_SIZE` | saved voices kept before the oldest is deleted; pool + 1 + studio voices must fit the plan's slots: `3` on Starter with 6 studio voices |
| `STUDIO_VOICE_IDS` | `presentation-age:voiceId` entries printed by `scripts/studio-voices.ts save`; the closest one by gender, then age, is used when no new voice can be saved |

Never set `FTV_MOCK_ELEVENLABS` or `FTV_MOCK_CLAUDE` on Vercel.

## 3. Upstash Redis (rate limits, daily caps, caches)

Vercel Marketplace → **Upstash** → Redis → free plan. The integration injects
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` / `KV_REST_API_TOKEN`;
both are accepted). Redeploy after adding it.

## 4. Vercel Blob (cached preview clips and spoken lines)

Storage → **Blob** → create a **public** store and connect it to the project; it injects
`BLOB_READ_WRITE_TOKEN`. Free tier: 1 GB and 2,000 write operations per month; the app writes
once per unique clip and never overwrites.

The same store hosts the **hair** (the strand files are ~220 MB and are not committed; see `.gitignore`).
Pull the token into `web/.env.local` (`vercel env pull web/.env.local`, or copy `BLOB_READ_WRITE_TOKEN`
from the store's page), then from `web/`:

    node scripts/upload-hair.ts --dry-run   # what would go up
    node scripts/upload-hair.ts             # uploads what is missing, writes src/data/hairBlob.json

Commit `src/data/hairBlob.json` and deploy: production fetches every hair style from Blob, and a clone gets the
same files for development with `pnpm fetch-hair` (into `public/models/hair/`). Run it again after any change to the hair set; files are stored by content,
so only new or changed styles upload (one write each, 245 for the first run).

## 5. Abuse protection

- **BotID** is wired in `next.config.ts` / `src/instrumentation-client.ts` and activates
  automatically on Vercel (free Basic tier). Nothing to configure.
- **Firewall → Rate limiting** (available on Hobby): one rule, e.g. path starts with `/api/`,
  60 requests per 60 s per IP → 429. Coarse outer layer; the precise limits live in Redis.
- Optional: **Attack Challenge Mode** as the emergency switch.

## 6. Studio voices

After the first deploy, run `scripts/studio-voices.ts` (see its header) to design six voices with the app's own template (man and woman at three ages,
each in an everyday and a character variant), pick one per slot, paste the printed `STUDIO_VOICE_IDS` line and redeploy. They are the
friendly fallback once the daily save cap or the monthly voice quota is spent.

## 7. Check it

- `/api/usage` with the admin token shows `store: "redis"` and `blob: true`.
- Lower `DAILY_CAP_SAVES` to `0` for a minute and confirm the UI shows the studio-voice message.
- `?perf=1` on the deployed site for fps and head-visible time on your phone.
