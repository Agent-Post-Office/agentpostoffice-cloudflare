import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { join } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@agentpostoffice/sieve": join(import.meta.dirname, "../sieve/src/index.ts") },
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: join(import.meta.dirname, "wrangler.test.jsonc") },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["packages/worker/test/**/*.test.ts"],
    setupFiles: ["packages/worker/test/setup.ts"],
  },
});
