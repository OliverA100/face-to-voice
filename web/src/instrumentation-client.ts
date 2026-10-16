// Runs once in the browser before the app hydrates. Tells BotID which routes carry the
// challenge token, but only on Vercel (NEXT_PUBLIC_VERCEL_ENV is set there automatically);
// anywhere else BotID's script cannot load and would break fetch() to these routes.
import { initBotId } from "botid/client/core";

import { bootChrome } from "@/components/ui/loader/chrome";

// The head loader's sphere starts moving now instead of once the whole app has loaded (seconds later on a slow first
// visit): components/ui/loader/chrome.tsx bootChrome.
bootChrome();

if (process.env.NEXT_PUBLIC_VERCEL_ENV) {
  initBotId({
    protect: [
      { path: "/api/voice/design", method: "POST" },
      { path: "/api/voice/recast", method: "POST" },
      { path: "/api/voice/select", method: "POST" },
      { path: "/api/voice/speak", method: "POST" },
      { path: "/api/character/profile", method: "POST" },
      { path: "/api/talk/token", method: "POST" },
    ],
  });
}
