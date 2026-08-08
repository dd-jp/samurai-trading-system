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
  resolve: {
    alias: {
      // The wire contract — the only thing this app may import from outside
      // its own directory. Before it existed the components reached backend
      // source directly (`../../../../dashboard/types.ts`), which put server
      // modules in this app's TypeScript program. Keep in step with the
      // `paths` entry in `tsconfig.json` and the alias in `vitest.config.ts`.
      '@contracts': fileURLToPath(new URL('../contracts/index.ts', import.meta.url)),
    },
  },
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
        // Same variable and default the dashboard server itself binds on
        // (src/dashboard/index.ts), so a nonstandard port only has to be set
        // once for both processes.
        target: `http://127.0.0.1:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});
