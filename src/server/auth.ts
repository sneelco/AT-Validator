import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { isSecretConfigured, type Bindings } from "./env";
import { APP } from "../shared/app";

/**
 * Better Auth factory. Bindings (D1) only exist inside a request on Workers,
 * so this MUST be called per request — never at module scope (§15).
 * Construction is cheap; Better Auth does no I/O until a handler runs.
 */
export function createAuth(env: Bindings) {
  const db = drizzle(env.AUTH_DB, { schema });
  const github =
    isSecretConfigured(env.GITHUB_CLIENT_ID) && isSecretConfigured(env.GITHUB_CLIENT_SECRET)
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {};

  return betterAuth({
    appName: APP.name,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    basePath: "/api/auth",
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      // No email transport is wired yet (see sendEmail below), so verification
      // cannot be required. Flip this once sendEmail does something real.
      requireEmailVerification: false,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({ to: user.email, subject: `${APP.name}: reset your password`, text: url });
      },
    },
    socialProviders: github,
    session: {
      // Cache the session in a signed cookie so most requests skip D1.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      apiKey({
        // Keys are the bearer token for /mcp (see middleware/api-key.ts).
        // Hashed at rest (default). Per-key rate limiting is off because it
        // costs a D1 write on every verify; the Worker's own limits apply.
        rateLimit: { enabled: false },
        enableMetadata: false,
        defaultPrefix: `${APP.id}_`,
      }),
    ],
    advanced: {
      // IDs as UUIDs keep the D1 schema simple and index-friendly.
      database: { generateId: () => crypto.randomUUID() },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthUser = Auth["$Infer"]["Session"]["user"];
export type AuthSession = Auth["$Infer"]["Session"]["session"];

/**
 * Email transport stub. Nothing is sent. When you add a provider (Resend,
 * Postmark, …) implement it here and set `EMAIL_CONFIGURED` to true so the
 * UI stops hiding "forgot password".
 */
export const EMAIL_CONFIGURED = false;

async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  // TODO: plug in a transport. Until then log so local dev can grab reset links.
  console.log(`[email stub] to=${msg.to} subject=${JSON.stringify(msg.subject)} body=${msg.text}`);
}
