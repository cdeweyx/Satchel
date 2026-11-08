import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fake values only. They override .dev.vars and process.env, so tests behave the same
// on every machine and never see a real secret.
const testBindings = {
  NOTION_DATABASE_ID: "test-database-id",
  NOTION_DATA_SOURCE_ID: "test-data-source-id",
  NOTION_TOKEN: "test-notion-token",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  SATCHEL_KEY: "test-satchel-key",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: testBindings },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
