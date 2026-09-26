import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { DASHBOARD_TOKEN_ENV_VAR } from '../server/apps/v2/api/auth.ts';
import { resolveE2ePort } from './support/port.ts';
import {
  CONTROLS_SERVER,
  DASHBOARD_SERVER,
  E2E_HOST,
  type FixtureServer,
  fixtureUrl,
  LOSS_BUDGET_SERVER,
} from './support/servers.ts';
import { E2E_TOKEN } from './support/token.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_COMMAND = 'node dist/server/apps/v2/api/fixture-server.js';

async function webServer(server: FixtureServer, command: string) {
  const port = await resolveE2ePort(E2E_HOST, server.portEnv);
  return {
    command,
    cwd: repoRoot,
    url: `http://${E2E_HOST}:${port}/`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      HOST: E2E_HOST,
      V2_FIXTURE_SCENARIO: server.scenario,
      [DASHBOARD_TOKEN_ENV_VAR]: E2E_TOKEN,
    },
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
}

const webServers = [
  await webServer(DASHBOARD_SERVER, `npm run build && ${FIXTURE_COMMAND}`),
  await webServer(CONTROLS_SERVER, FIXTURE_COMMAND),
  await webServer(LOSS_BUDGET_SERVER, FIXTURE_COMMAND),
];

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
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
    baseURL: fixtureUrl(DASHBOARD_SERVER),
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'no-preference' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: webServers,
});
