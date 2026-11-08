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

// Two projects: the Worker's tests run in workerd; the Chrome extension's tests
// (test/extension-*.test.ts) run in plain node against test/chrome-mock.ts.
const extensionTests = "test/extension-*.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: testBindings },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: ["**/node_modules/**", extensionTests],
          setupFiles: ["./test/setup.ts"],
        },
      },
      {
        test: {
          name: "extension",
          environment: "node",
          include: [extensionTests],
        },
      },
    ],
  },
});
