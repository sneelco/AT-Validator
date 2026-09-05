import { z } from "zod";
import { applyPatch, type Operation } from "fast-json-patch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getState, replaceState } from "../state-store";
import { parseState, stateSchema, type AppState } from "../../shared/state";
import type { StateEnvelope } from "../../shared/api-types";

/** Everything a tool needs: who is calling and where their state lives. */
export interface ToolContext {
  userId: string;
  kv: KVNamespace;
}

const jsonPatchOp = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
});

/**
 * Core tools present in every Outpost app: read, replace, and patch the
 * user's state blob. These never change per app; app-specific tools go in
 * tools.app.ts.
 */
export function registerCoreTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_state",
    {
      title: "Get state",
      description: "Return the current state envelope for the authenticated user (appId, schemaVersion, rev, updatedAt, data). Returns rev 0 and empty data if nothing has been saved yet.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const envelope = await getState(ctx.kv, ctx.userId);
      return jsonResult(envelope ?? emptyEnvelopeFor());
    },
  );

  server.registerTool(
    "replace_state",
    {
      title: "Replace state",
      description: "Replace the entire state `data` object. It is validated against the app schema before writing. The server assigns the next rev. Call get_state first so you do not clobber recent edits.",
      inputSchema: { data: z.record(z.string(), z.unknown()).describe("The full state object matching the app schema") },
      annotations: { destructiveHint: true },
    },
    async ({ data }) => {
      const parsed = validateOrError(data);
      if (parsed.error) return parsed.error;
      const result = await replaceState(ctx.kv, ctx.userId, parsed.data);
      if (!result.ok) return errorResult(`Write failed: ${result.reason}`);
      return jsonResult(result.envelope);
    },
  );

  server.registerTool(
    "patch_state",
    {
      title: "Patch state",
      description: "Apply an RFC 6902 JSON Patch to the current state `data`. The patched result is validated against the app schema before writing; if any operation fails nothing is written. Prefer this over replace_state for small edits.",
      inputSchema: { patch: z.array(jsonPatchOp).min(1).describe("JSON Patch operations applied to `data`") },
    },
    async ({ patch }) => {
      const current = await getState(ctx.kv, ctx.userId);
      const base = current?.data ?? parseState({});
      let patched: unknown;
      try {
        patched = applyPatch(structuredClone(base), patch as Operation[], true, false).newDocument;
      } catch (err) {
        return errorResult(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsed = validateOrError(patched);
      if (parsed.error) return parsed.error;
      const result = await replaceState(ctx.kv, ctx.userId, parsed.data);
      if (!result.ok) return errorResult(`Write failed: ${result.reason}`);
      return jsonResult(result.envelope);
    },
  );

  server.registerResource(
    "current-state",
    "state://current",
    {
      title: "Current state",
      description: "The authenticated user's current state envelope as JSON.",
      mimeType: "application/json",
    },
    async (uri) => {
      const envelope = await getState(ctx.kv, ctx.userId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(envelope ?? emptyEnvelopeFor(), null, 2) }],
      };
    },
  );
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

type Validated = { data: AppState; error?: undefined } | { data?: undefined; error: ToolResult };

function validateOrError(data: unknown): Validated {
  const r = stateSchema.safeParse(data);
  if (r.success) return { data: r.data };
  return { error: errorResult(`State does not match the schema:\n${r.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`) };
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function emptyEnvelopeFor(): StateEnvelope {
  return { appId: "", schemaVersion: 0, rev: 0, updatedAt: "", data: parseState({}) };
}
