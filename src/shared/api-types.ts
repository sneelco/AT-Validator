import { z } from "zod";
import { APP } from "./app";

/**
 * The envelope that wraps a user's state blob in KV and on the wire.
 * `rev` is server-assigned and monotonically increasing; clients send the
 * rev they last saw as `baseRev` so the server can reject stale writes.
 */
export interface StateEnvelope<T = unknown> {
  appId: string;
  schemaVersion: number;
  rev: number;
  updatedAt: string;
  data: T;
}

export const envelopeSchema = z.object({
  appId: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  rev: z.number().int().nonnegative(),
  updatedAt: z.string(),
  data: z.unknown(),
});

/** Body of PUT /api/state. */
export interface PutStateRequest<T = unknown> {
  baseRev: number;
  data: T;
}

export const putStateRequestSchema = z.object({
  baseRev: z.number().int().nonnegative(),
  data: z.unknown(),
});

/** Uniform JSON error shape returned by the API. */
export interface ApiError {
  error: {
    code:
      | "unauthorized"
      | "bad_request"
      | "validation_failed"
      | "conflict"
      | "payload_too_large"
      | "not_found"
      | "internal";
    message: string;
    /** For "conflict": the current server envelope so the client can merge. */
    current?: StateEnvelope;
    /** For "validation_failed": flattened Zod issues. */
    issues?: unknown;
  };
}

export interface HealthResponse {
  ok: true;
  app: string;
  version: string;
  time: string;
}

/** Soft cap on the serialized state blob; configured per app in shared/app.ts. */
export const MAX_STATE_BYTES: number = APP.maxStateBytes;
