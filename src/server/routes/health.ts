import { Hono } from "hono";
import type { AppEnv } from "../middleware/session";
import { APP_ID } from "../../shared/app";
import type { HealthResponse } from "../../shared/api-types";
import { APP_VERSION } from "../../shared/version";

export const healthRoute = new Hono<AppEnv>().get("/", (c) => {
  // APP_VERSION is baked in by Vite at build time (CI passes the commit SHA);
  // the wrangler var is the fallback for plain `wrangler dev`.
  const version = APP_VERSION !== "dev" ? APP_VERSION : c.env.APP_VERSION;
  const body: HealthResponse = { ok: true, app: APP_ID, version, time: new Date().toISOString() };
  return c.json(body);
});
