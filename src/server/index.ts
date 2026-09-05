import { Hono } from "hono";
import { logger } from "hono/logger";
import { createAuth, EMAIL_CONFIGURED } from "./auth";
import { isSecretConfigured } from "./env";
import type { AppEnv } from "./middleware/session";
import { healthRoute } from "./routes/health";
import { stateRoute } from "./routes/state";
import { mcpRoute } from "./mcp/server";
import { APP_ID } from "../shared/app";
import { APP_VERSION } from "../shared/version";

/**
 * The Worker. Static assets (the Vite-built SPA) are served by the Workers
 * assets layer for every path not listed in `run_worker_first`, so this app
 * only ever sees /api/* and /mcp.
 */
const app = new Hono<AppEnv>();

app.use(logger());

// Uniform JSON errors; never leak stack traces.
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: "internal", message: "Unexpected error." } }, 500);
});
app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.route("/api/health", healthRoute);

// Public, non-secret feature flags the client needs before signing in.
app.get("/api/config", (c) =>
  c.json({
    app: APP_ID,
    version: APP_VERSION !== "dev" ? APP_VERSION : c.env.APP_VERSION,
    providers: { github: isSecretConfigured(c.env.GITHUB_CLIENT_ID) && isSecretConfigured(c.env.GITHUB_CLIENT_SECRET) },
    passwordReset: EMAIL_CONFIGURED,
  }),
);

// Better Auth handles everything under /api/auth/*. Built per request (§15).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.route("/api/state", stateRoute);
app.route("/mcp", mcpRoute);

export default app;
