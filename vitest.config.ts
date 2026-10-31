import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentpostoffice/client": fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { reporter: ["text", "json", "html"] },
  },
});
