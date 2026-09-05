import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Two projects:
//  - "unit":    pure functions in src/shared and src/client run in Node.
//  - "workers": src/server tests run inside workerd with real KV/D1 bindings
//               (Miniflare), so the rev-conflict path is tested end to end.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/shared/**/*.test.ts", "src/client/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Migrations are applied in test/setup.ts before each run.
              bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["src/server/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
