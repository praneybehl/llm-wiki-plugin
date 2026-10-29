import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
          // Alarms run only through runDurableObjectAlarm, so slow test runs stay deterministic.
          LLM_WIKI_ALARM_DELAY_MS: "3600000",
        },
      },
    }),
  ],
});
