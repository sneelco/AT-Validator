import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { requireUser, sessionMiddleware, type AppEnv } from "../middleware/session";
import { deleteState, getState, putState } from "../state-store";
import { MAX_STATE_BYTES, putStateRequestSchema } from "../../shared/api-types";
import { parseState } from "../../shared/state";

/**
 * /api/state — the per-user JSON blob.
 *   GET    → 200 envelope | 204 nothing stored yet
 *   PUT    { baseRev, data } → 200 new envelope | 409 { error.current } | 413 | 422
 *   DELETE → 204
 */
export const stateRoute = new Hono<AppEnv>()
  .use(sessionMiddleware, requireUser)

  .get("/", async (c) => {
    const envelope = await getState(c.env.STATE, c.var.user!.id);
    if (!envelope) return c.body(null, 204);
    return c.json(envelope);
  })

  .put("/", async (c) => {
    // Cheap size guard before parsing anything.
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_STATE_BYTES * 1.5) return tooLarge(c, len);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "bad_request", message: "Body must be JSON." } }, 400);
    }
    const parsedReq = putStateRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json({ error: { code: "validation_failed", message: "Expected { baseRev, data }.", issues: parsedReq.error.issues } }, 422);
    }

    let data;
    try {
      data = parseState(parsedReq.data.data);
    } catch (err) {
      const issues = err instanceof ZodError ? err.issues : undefined;
      return c.json({ error: { code: "validation_failed", message: "State does not match the schema.", issues } }, 422);
    }

    const result = await putState(c.env.STATE, c.var.user!.id, parsedReq.data.baseRev, data);
    if (result.ok) return c.json(result.envelope);
    if (result.reason === "conflict") {
      return c.json({ error: { code: "conflict", message: "Your copy is stale. Merge with `current` and retry.", current: result.current } }, 409);
    }
    return tooLarge(c, result.bytes);
  })

  .delete("/", async (c) => {
    await deleteState(c.env.STATE, c.var.user!.id);
    return c.body(null, 204);
  });

function tooLarge(c: Context<AppEnv>, bytes: number) {
  return c.json(
    { error: { code: "payload_too_large", message: `State is ${bytes} bytes; the limit is ${MAX_STATE_BYTES}.` } },
    413,
  );
}
