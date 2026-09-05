/**
 * Build version. Vite `define` replaces __APP_VERSION__ with the commit SHA in
 * both the client and Worker bundles; under plain Vitest or `wrangler dev`
 * it is undefined, so fall back to "dev".
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
