import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { DASHBOARD_CREDENTIAL_ENV_VAR } from '../server/shared/http/bind-guard.ts';
import { resolveE2ePort } from './support/port.ts';

const HOST = '127.0.0.1';
const PORT = await resolveE2ePort(HOST);
const BASE_URL = `http://${HOST}:${PORT}`;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'no-preference' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && node dist/server/apps/service-api/fixture-server.js',
    cwd: repoRoot,
    url: `${BASE_URL}/api/snapshot`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      SAMURAI_MODE: 'paper',
      PORT: String(PORT),
      HOST,
      [DASHBOARD_CREDENTIAL_ENV_VAR]: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
