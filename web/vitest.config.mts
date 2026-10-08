import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// .mts: an ES module whatever package.json says (the package has no "type": "module").
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
