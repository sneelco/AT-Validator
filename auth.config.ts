// Used ONLY by the Better Auth CLI (`pnpm auth:generate`) to derive the
// Drizzle schema from the configured plugins. It is never imported by the app.
// The D1 binding is only available inside a request, so the real auth
// instance is built per request in src/server/auth.ts.
import { createAuth } from "./src/server/auth";

import type { Bindings } from "./src/server/env";

export const auth = createAuth({
  AUTH_DB: {},
  STATE: {},
  BETTER_AUTH_SECRET: "cli-only-secret-not-used-anywhere-0000000",
  BETTER_AUTH_URL: "http://localhost:5173",
  APP_VERSION: "dev",
} as unknown as Bindings);
