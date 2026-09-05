# Decisions and deviations from the spec

Where the current Cloudflare / Better Auth / Hono docs or practicalities argued
for something other than the handoff spec, this is the record.

## Build and dev: Cloudflare Vite plugin instead of "Vite + wrangler dev"

`@cloudflare/vite-plugin` gives one `pnpm dev` with HMR for the client and the
Worker running in workerd with real local bindings, and `vite build` emits both
`dist/client` and `dist/<worker>/` plus a `wrangler.json` for the built Worker.
It also writes `.wrangler/deploy/config.json`, which redirects plain
`wrangler deploy` / `wrangler versions upload` at the built config. Consequences:

- `assets.directory` is **not** set in `wrangler.jsonc`; the plugin fills it in.
- CI must run `pnpm build` before any `wrangler` command (the preview job
  recreates the gitignored redirect file from the downloaded `dist/` artifact).
- `wrangler.jsonc` keeps `main: ./src/server/index.ts` so `wrangler types`
  and the Vitest plugin can still read it directly.

## Versions

Pinned at build time (September 2026) and verified against npm:
wrangler 4.129, Hono 4.13, Better Auth 1.7 (API-key plugin and Drizzle adapter
now live in `@better-auth/api-key` and `@better-auth/drizzle-adapter`; the CLI
is the `auth` package), `@hono/mcp` 0.3, MCP SDK 1.30, Vite 8, React 19.2,
Zod 4, Zustand 5, react-router 8, Tailwind 4, vite-plugin-pwa 1.3.
TypeScript is pinned to 5.9 because typescript-eslint does not yet support 7.x.
Vitest is 4.1 (not 5) because `@cloudflare/vitest-plugin` requires `^4.1`.

## Testing: `@cloudflare/vitest-plugin`

The spec names `@cloudflare/vitest-pool-workers`; Cloudflare's current docs
point to its successor `@cloudflare/vitest-plugin` (`cloudflareTest()`), which
is what is used. Server tests run inside Miniflare with real KV and D1 (the
migrations are applied in `test/setup.ts`), so the 401/204/200/409/422 paths
and the API-key → MCP round trip are covered end to end.

## Better Auth schema is generated, not hand-written

`auth.config.ts` exists only so `auth generate` can introspect the plugins. The
Drizzle schema in `src/server/db/schema.ts` and the SQL in `migrations/` are
generated output; regenerate them rather than editing by hand
(`pnpm auth:generate && pnpm db:generate`).

`better-auth-cloudflare` was evaluated and not adopted: it adds a layer over the
same Drizzle + D1 wiring and its last release predates Better Auth 1.7.

## API keys: per-key rate limiting disabled

The API-key plugin defaults to 10 requests/day per key with a D1 write on every
verification. MCP clients make many small calls, so per-key rate limiting is
off (`rateLimit: { enabled: false }`). Better Auth's global request rate limiter
still applies. Revisit if abuse ever matters.

## `APP_VERSION` is baked in by Vite, not passed as a Wrangler var

Because the Vite plugin builds the Worker, a single `define` makes the commit
SHA available in both bundles (`src/shared/version.ts`). The `vars.APP_VERSION`
in `wrangler.jsonc` remains as a fallback for plain `wrangler dev`.

## patch_state uses JSON Patch

`fast-json-patch` (small, no deps). The patch is applied to a clone, validated
against the schema, and only then written. Invalid patches write nothing.

## Demo merge is id-based, not tombstoned

`mergeState` in the demo unions notes by id. A note deleted on one device while
edited on another will reappear. That is fine for a demo; real apps that need
deletes to win should carry tombstones or drop `mergeState` to get whole-blob
last-writer-wins.

## Email

No transport. `sendEmail` in `src/server/auth.ts` logs. Because of that,
`requireEmailVerification` is off and the UI hides "forgot password" (driven by
`/api/config`'s `passwordReset: false`). Wire Resend or similar and flip
`EMAIL_CONFIGURED`.

## Passkeys

Not included. Better Auth's passkey plugin works on Workers but adds a table
and a dependency for an app that already has GitHub OAuth optional; left as a
TODO in `src/server/auth.ts` if wanted.

## Open questions from the spec, resolved with defaults

- Demo feature: a notes list.
- Email transport: none for now.
- patch_state: JSON Patch.
