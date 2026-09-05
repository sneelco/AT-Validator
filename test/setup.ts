import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// Apply the D1 migrations to the isolated per-test database before each run.
// TEST_MIGRATIONS is populated in vitest.config.ts via readD1Migrations; it is
// a test-only binding, so it is not part of the Worker's generated Env type.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
await applyD1Migrations(env.AUTH_DB, migrations);
