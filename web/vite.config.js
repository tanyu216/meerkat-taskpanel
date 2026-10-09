import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * Board frontend build (M6b, plan §F6/F7).
 *
 * `web/dist` is the artefact path the backend actually hosts
 * (`src/shared/constants.mjs` → `STATIC_DIR_REL = "web/dist"`). `root` is this
 * directory, so Vite's default `outDir` is already `web/dist`; it is named
 * explicitly so the contract is visible rather than implied.
 *
 * Dev serves over Vite and proxies the real backend so the SPA talks to the
 * same relative URLs in dev and in production (where `taskd` serves `web/dist`
 * from the same origin). `base: "/"` — the frontend is mounted at the root.
 */
export default defineConfig({
  base: "/",
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist", // -> web/dist
    emptyOutDir: true,
  },
  server: {
    // The board's own `taskd` (src/server). Local-only.
    proxy: {
      // NOTE: `/api/v1/events` is a Server-Sent Events stream. Vite's proxy
      // must pass it through unbuffered and uncompressed — any compression or
      // response-buffering layer will batch events and break incrementality.
      // `changeOrigin` keeps the Host header the backend sees sane; do not add
      // a compressing middleware in front of `/api`.
      "/api": { target: "http://127.0.0.1:9527", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:9527", changeOrigin: true },
    },
  },
});
