// Runs once in the browser before the app hydrates. Tells BotID which routes carry the
// challenge token, but only on Vercel (NEXT_PUBLIC_VERCEL_ENV is set there automatically);
// anywhere else BotID's script cannot load and would break fetch() to these routes.
import { initBotId } from "botid/client/core";

if (process.env.NEXT_PUBLIC_VERCEL_ENV) {
  initBotId({
    protect: [
      { path: "/api/voice/design", method: "POST" },
      { path: "/api/voice/select", method: "POST" },
      { path: "/api/voice/speak", method: "POST" },
    ],
  });
}
