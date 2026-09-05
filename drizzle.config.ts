import { defineConfig } from "drizzle-kit";

// Only used for `pnpm db:generate` (SQL migration files from the Drizzle
// schema). Applying migrations is Wrangler's job: `pnpm db:migrate:local`
// and `pnpm db:migrate:remote`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
});
