import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";

/** Same-origin Better Auth client. `baseURL` is omitted on purpose. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

export interface PublicConfig {
  app: string;
  version: string;
  providers: { github: boolean };
  passwordReset: boolean;
}

let configPromise: Promise<PublicConfig> | null = null;
/** Non-secret feature flags from the Worker (which OAuth providers exist, etc.). */
export function fetchPublicConfig(): Promise<PublicConfig> {
  configPromise ??= fetch("/api/config")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => ({ app: "", version: "unknown", providers: { github: false }, passwordReset: false }));
  return configPromise;
}
