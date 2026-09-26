import type { FixtureScenario } from '../../server/apps/v2/api/fixture-server.ts';

export const E2E_HOST = '127.0.0.1';

export interface FixtureServer {
  readonly portEnv: string;
  readonly scenario: FixtureScenario;
}

export const DASHBOARD_SERVER: FixtureServer = { portEnv: 'SAMURAI_E2E_PORT', scenario: 'default' };
export const CONTROLS_SERVER: FixtureServer = {
  portEnv: 'SAMURAI_E2E_PORT_CONTROLS',
  scenario: 'default',
};
export const LOSS_BUDGET_SERVER: FixtureServer = {
  portEnv: 'SAMURAI_E2E_PORT_LOSS_BUDGET',
  scenario: 'loss-budget-halted',
};

export function fixtureUrl(server: FixtureServer): string {
  const port = process.env[server.portEnv];
  if (port === undefined || port === '') {
    throw new Error(`${server.portEnv} is unset; run the e2e suite through playwright.config.ts`);
  }
  return `http://${E2E_HOST}:${port}`;
}
