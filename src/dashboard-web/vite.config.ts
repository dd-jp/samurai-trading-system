import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `root` is set explicitly rather than left to Vite's default
// (`process.cwd()`): `build:web` invokes this config with
// `--config src/dashboard-web/vite.config.ts` from the repo root, and an
// implicit root would resolve `index.html` against the wrong directory
// depending on the caller's cwd.
const appRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: appRoot,
  // Relative base so the built bundle is servable straight off disk with no
  // path prefix (dashboard-spec.md, "Structure": "a relative `base` so the
  // bundle is servable from disk without a path prefix").
  base: './',
  plugins: [react()],
  build: {
    // Outside the Vite `root`, so `emptyOutDir` must be explicit — Vite
    // otherwise warns and refuses to clean a directory it doesn't consider
    // part of the project, and stale hashed assets would accumulate across
    // builds.
    outDir: fileURLToPath(new URL('../../dist/dashboard-web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Dev-only convenience: `yarn dev:web` serves the app from Vite's dev
      // server but talks to the real dashboard HTTP server (dashboard-spec.md
      // "Module: HTTP Server") for `/api/snapshot`. Production never proxies
      // — the built bundle and the JSON endpoint are served by the same
      // `node:http` process.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
