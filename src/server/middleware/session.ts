import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { createAuth, type Auth, type AuthSession, type AuthUser } from "../auth";
import type { Bindings } from "../env";

/** Hono environment shared by every route: bindings + per-request variables. */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    auth: Auth;
    user: AuthUser | null;
    session: AuthSession | null;
  };
};

/**
 * Builds the per-request Better Auth instance and resolves the cookie session
 * (cheap: the cookie cache avoids D1 for most requests). Sets `c.var.user`
 * to the user or null. Never rejects — pair with `requireUser` for that.
 */
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = createAuth(c.env);
  c.set("auth", auth);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", result?.user ?? null);
  c.set("session", result?.session ?? null);
  await next();
});

/** 401 JSON unless a cookie session resolved a user. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user) return unauthorized(c, "Sign in to access this resource.");
  await next();
});

export function unauthorized(c: Context<AppEnv>, message: string, bearer = false) {
  if (bearer) c.header("WWW-Authenticate", 'Bearer realm="mcp"');
  return c.json({ error: { code: "unauthorized", message } }, 401);
}
