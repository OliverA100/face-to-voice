import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // three's Basis Universal transcoder, copied in as is (lib/textures.ts)
    "public/basis/**",
    // the production loader worker, joined from chromeGl.ts and chromeWorker.ts at build time (next.config.ts)
    "public/chrome/**",
  ]),
]);

export default eslintConfig;
