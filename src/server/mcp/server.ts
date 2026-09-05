import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { apiKeyMiddleware } from "../middleware/api-key";
import type { AppEnv } from "../middleware/session";
import { registerCoreTools } from "./tools.core";
import { appTools } from "./tools.app";
import { APP } from "../../shared/app";
import { APP_VERSION } from "../../shared/version";

/**
 * /mcp — Streamable HTTP MCP endpoint.
 *
 * Stateless by design (§9): a fresh McpServer + transport per request, no
 * session ids, no Durable Object. Every request must carry a bearer API key;
 * the resolved user scopes all tools to their own KV state.
 */
export const mcpRoute = new Hono<AppEnv>().use(apiKeyMiddleware).all("/", async (c) => {
  const server = new McpServer({ name: `${APP.id}-mcp`, version: APP_VERSION });
  const ctx = { userId: c.var.user!.id, kv: c.env.STATE };
  registerCoreTools(server, ctx);
  for (const register of appTools) register(server, ctx);

  const transport = new StreamableHTTPTransport({
    // Stateless: no session id → every POST is self-contained.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
});
