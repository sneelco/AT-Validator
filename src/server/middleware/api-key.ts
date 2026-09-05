import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createAuth } from "../auth";
import * as schema from "../db/schema";
import { unauthorized, type AppEnv } from "./session";

/**
 * Bearer API-key auth for /mcp. Cookies are deliberately ignored here: an MCP
 * client is not a browser and must not ride on a browser session.
 *
 * Accepts `Authorization: Bearer <key>` (preferred) or `x-api-key: <key>`.
 * Keys are created on the account page and stored hashed by Better Auth.
 */
export const apiKeyMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const key = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (!key) return unauthorized(c, "Provide an API key as a Bearer token.", true);

  const auth = createAuth(c.env);
  c.set("auth", auth);

  const verified = await auth.api.verifyApiKey({ body: { key } });
  if (!verified.valid || !verified.key) {
    const message = typeof verified.error?.message === "string" ? verified.error.message : "Invalid API key.";
    return unauthorized(c, message, true);
  }

  const db = drizzle(c.env.AUTH_DB, { schema });
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, verified.key.referenceId) });
  if (!user) return unauthorized(c, "API key owner no longer exists.", true);

  c.set("user", user);
  c.set("session", null);
  await next();
});

export function extractKey(authorization: string | undefined, xApiKey: string | undefined): string | null {
  if (authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (m?.[1]) return m[1].trim();
  }
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();
  return null;
}
