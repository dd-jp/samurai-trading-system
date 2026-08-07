import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
