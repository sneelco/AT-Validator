import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import { APP } from "./src/shared/app";

// APP_VERSION is set by CI to the commit SHA. It is baked into both the client
// bundle and the Worker bundle (Vite builds both), so /api/health and the
// account page report the same value.
const appVersion = process.env.APP_VERSION ?? "dev";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      // Registration lives in src/client/components/UpdateToast.tsx via
      // virtual:pwa-register/react so the UI can show "update available".
      injectRegister: null,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: APP.name,
        short_name: APP.shortName,
        description: APP.description,
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: APP.backgroundColor,
        theme_color: APP.themeColor,
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell (everything Vite emits for the client).
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        // SPA fallback for navigations, except API/MCP/auth routes which must
        // never be answered by the service worker.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/],
        // Guardrail (§15): /api and /mcp are NetworkOnly. The store already
        // handles offline; a stale API response would corrupt sync.
        runtimeCaching: [
          { urlPattern: /^\/api\//, handler: "NetworkOnly" },
          { urlPattern: /^\/mcp/, handler: "NetworkOnly" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 900,
  },
});
