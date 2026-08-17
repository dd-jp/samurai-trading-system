import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The web app's half of the wire boundary. Must agree with the `paths`
      // entry in `client/tsconfig.json` and the `resolve.alias` in
      // `client/vite.config.ts` — three declarations of one mapping, because
      // type-checking, bundling and testing each resolve independently.
      // A disagreement surfaces as a module-not-found in whichever one drifted.
      '@contracts': fileURLToPath(new URL('./contracts/index.ts', import.meta.url)),
    },
  },
  // Needed so the JSX transform in `client/src/App.test.tsx` (issue #536's
  // smoke test) is not left to esbuild defaults. Scoped to the web app's
  // `.tsx` files because the plugin's default include (`/\.[tj]sx?$/`) would
  // put every plain-`.ts` server test through an extra Babel parse per run —
  // the server suite stays on esbuild.
  plugins: [react({ include: /client\/.+\.tsx$/ })],
  test: {
    // `.test.tsx` added for the client component smoke test
    // (dashboard-spec.md, "Testing Decisions": "Component tests (RTL)").
    // Per-file `environment` (jsdom) is set via a `// @vitest-environment`
    // docblock in that file rather than here, so every other test — which
    // needs the real `node` environment for SQLite — is unaffected.
    include: [
      'server/**/*.test.ts',
      'contracts/**/*.test.ts',
      'client/**/*.test.ts',
      'client/**/*.test.tsx',
    ],
    environment: 'node',
    globals: true,
    // Fails the run if any test created, replaced or deleted a real
    // `data/samurai-*.sqlite` in this checkout — see the file for the incident
    // this exists to prevent.
    globalSetup: ['./vitest.global-setup.ts'],
    // Fails any test FILE that tried to reach a host off this machine. Runs
    // per file rather than once per run (unlike `globalSetup` above) because
    // `globalThis.fetch` is per-worker state and the report has to name the
    // file that escaped — see the file for the 92-passing-tests-two-live-vendors
    // measurement that produced it.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'contracts/**/*.ts'],
      exclude: ['server/**/*.test.ts', 'server/**/index.ts', 'contracts/**/*.test.ts'],
    },
  },
});
