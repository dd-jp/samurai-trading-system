import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The web app's half of the wire boundary. Must agree with the `paths`
      // entry in `src/dashboard-web/tsconfig.json` and the `resolve.alias` in
      // its `vite.config.ts` — three declarations of one mapping, because
      // type-checking, bundling and testing each resolve independently.
      // A disagreement surfaces as a module-not-found in whichever one drifted.
      '@contracts': fileURLToPath(new URL('./src/contracts/index.ts', import.meta.url)),
    },
  },
  // Needed so the JSX transform in `src/dashboard-web/src/App.test.tsx`
  // (issue #536's smoke test) is not left to esbuild defaults. Scoped to the
  // web app's `.tsx` files because the plugin's default include
  // (`/\.[tj]sx?$/`) would put every plain-`.ts` backend test through an
  // extra Babel parse per run — the backend suite stays on esbuild.
  plugins: [react({ include: /src\/dashboard-web\/.+\.tsx$/ })],
  test: {
    // `.test.tsx` added for the dashboard-web component smoke test
    // (dashboard-spec.md, "Testing Decisions": "Component tests (RTL)").
    // Per-file `environment` (jsdom) is set via a `// @vitest-environment`
    // docblock in that file rather than here, so every other test — which
    // needs the real `node` environment for SQLite — is unaffected.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    globals: true,
    // Fails the run if any test created, replaced or deleted a real
    // `data/samurai-*.sqlite` in this checkout — see the file for the incident
    // this exists to prevent.
    globalSetup: ['./vitest.global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
});
