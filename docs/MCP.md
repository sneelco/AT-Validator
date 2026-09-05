# Using the MCP endpoint

Every Outpost app exposes `https://<your-app>/mcp`, a stateless
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
MCP server scoped to one user's state.

## 1. Create an API key

Sign in → account menu → **Account** → **API keys** → **New key**. Copy it; it is
shown once. Keys are stored hashed. Revoke any time from the same page.

## 2. Connect a client

Send the key as a bearer token. Cookies are ignored on `/mcp`.

**claude.ai / Claude Desktop (remote MCP, custom connector):**
Settings → Connectors → *Add custom connector* → URL `https://<your-app>/mcp`.
When asked for authentication, choose a custom header / bearer token and paste
the key. (If the UI only offers OAuth, use the `mcp-remote` bridge below.)

**Claude Code:**

```sh
claude mcp add --transport http my-app https://<your-app>/mcp \
  --header "Authorization: Bearer <key>"
```

**Any stdio-only client via `mcp-remote`:**

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>/mcp",
               "--header", "Authorization: Bearer ${MY_APP_KEY}"],
      "env": { "MY_APP_KEY": "<key>" }
    }
  }
}
```

**curl smoke test:**

```sh
curl -s https://<your-app>/mcp \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_state","arguments":{}}}'
```

## 3. What is exposed

| Kind | Name | Notes |
|---|---|---|
| tool | `get_state` | Returns the envelope `{ appId, schemaVersion, rev, updatedAt, data }` |
| tool | `replace_state({ data })` | Validates `data` against the app schema and writes it with the next rev |
| tool | `patch_state({ patch })` | RFC 6902 JSON Patch applied to `data`; validated before writing |
| resource | `state://current` | Same as `get_state`, as an `application/json` resource |
| tools | app-specific | Defined in `src/server/mcp/tools.app.ts` (the template ships `summarize_notes` and `add_note`) |

Writes from MCP bump `rev`, so an open browser tab picks them up on its next
pull (tab focus, reconnect, or every few minutes) and merges them with any
unsynced local edits.

## Security notes

- No key → `401` with `WWW-Authenticate: Bearer`. Invalid or revoked key → `401`.
- A key grants full read/write to that one user's state, nothing else.
- Keys never expire by default; revoke from the account page.
