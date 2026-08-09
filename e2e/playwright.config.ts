/**
 * Playwright configuration for the dashboard e2e suite (#544).
 *
 * The suite exists because the redesign shipped a bug no unit test could see:
 * every chip teleported instead of walking (#595, fixed in #605), because
 * jsdom has neither `ResizeObserver` nor `document.fonts` and those were the
 * exact triggers that clobbered the walk. A shim is a model of a browser; this
 * runs the built bundle in a real one.
 *
 * Two seams serve `/api/snapshot`, chosen per scenario and named in each spec:
 *
 *  1. **The real server over a fixture store** — `dist/server/apps/service-api/fixture-server.js`
 *     boots `createDashboardServer` with an in-memory `DashboardQueryStore`
 *     (see that file). Boot, placement, drawer and keyboard scenarios read it,
 *     so those assertions cover the production static handler, `buildSnapshot`
 *     and the wire shape end to end.
 *  2. **`page.route` over that server's own payload** — scenarios that need a
 *     SEQUENCE of polls (a walk, a settle, a hang) fetch the real snapshot
 *     once and serve typed transforms of it. Hand-built payloads are avoided
 *     deliberately: `toWireSnapshot` silently discards a body that fails its
 *     shape check, which would look like a stale page rather than a broken
 *     fixture.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/** Not 8787 — that is the port a developer's own `yarn dashboard` holds. */
const PORT = 8788;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * Repo root, resolved from THIS FILE rather than from `process.cwd()`: the
 * server builds and serves out of the checkout the config lives in, whatever
 * directory `yarn e2e` was invoked from.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
  // The walk and staleness scenarios assert on sampled motion over a fixed
  // 3-second poll clock, so they are measurably sensitive to a loaded machine.
  // One worker costs about a minute and removes that variable; retries are off
  // for the same reason — a retried green here would hide exactly the class of
  // defect the suite is for.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: fileURLToPath(new URL('./playwright-report', import.meta.url)),
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Pinned rather than inherited: the walk scenarios assert that motion
    // HAPPENS, and a runner whose OS asks for reduced motion would turn every
    // walk into a snap and fail them for the wrong reason. The reduced-motion
    // scenario overrides this per-file.
    contextOptions: { reducedMotion: 'no-preference' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Builds what it serves: the point of this suite is the real bundle, and a
    // stale `dist/` would test bytes nobody is shipping.
    command: 'yarn build && node dist/server/apps/service-api/fixture-server.js',
    cwd: repoRoot,
    url: `${BASE_URL}/api/snapshot`,
    // `tsc` + `vite build` from cold; the 60s default is not enough.
    timeout: 300_000,
    // Never adopt a server this run did not build, in CI or locally.
    reuseExistingServer: false,
    env: {
      // Mandatory by design — `resolveStoreMode()` throws without it, and a
      // dashboard that guessed its mode is the one failure that matters.
      SAMURAI_MODE: 'paper',
      PORT: String(PORT),
      HOST,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
