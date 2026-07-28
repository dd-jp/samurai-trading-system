/**
 * Entrypoint tests (#236). The value here is the fail-fast contract: an
 * operator running `npm run orchestrator` against a half-wired environment
 * must get a message naming what is missing, before anything touches a
 * broker — not a process that starts and trades on invented defaults.
 *
 * Importing this module must also be side-effect free (it is the package's
 * export surface as well as the entrypoint); every test below relies on that
 * implicitly, since a top-level start would hang the suite.
 */
import { describe, expect, it } from 'vitest';
import { REQUIRED_INJECTED_CONFIG, startFromEnvironment } from './index.js';

describe('startFromEnvironment', () => {
  it('refuses to start with nothing wired, naming every missing dependency', async () => {
    await expect(startFromEnvironment()).rejects.toThrow(/cannot start/i);

    const error = await startFromEnvironment().catch((e: unknown) => e as Error);
    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(error.message).toContain(key);
    }
  });

  it('names only the dependencies that are actually missing', async () => {
    const error = await startFromEnvironment({
      llmClient: {} as never,
      traderConfig: {} as never,
    }).catch((e: unknown) => e as Error);

    expect(error.message).not.toMatch(/\bllmClient\b/);
    expect(error.message).not.toMatch(/\btraderConfig\b/);
    expect(error.message).toContain('alpacaBrokerClient');
  });

  it('rejects an unrecognised SAMURAI_MODE rather than casting it through', async () => {
    // `backtest` auto-approves every HITL gate and `live` spends real money,
    // so a typo must not reach VerdictImpl/ExecutionImpl as an opaque string.
    const previous = process.env.SAMURAI_MODE;
    process.env.SAMURAI_MODE = 'papper';
    try {
      const wired = Object.fromEntries(REQUIRED_INJECTED_CONFIG.map((key) => [key, {}])) as Record<
        string,
        unknown
      >;
      await expect(startFromEnvironment(wired as never)).rejects.toThrow(/SAMURAI_MODE/);
    } finally {
      if (previous === undefined) delete process.env.SAMURAI_MODE;
      else process.env.SAMURAI_MODE = previous;
    }
  });

  it('lists every transport and stage config as a required injection', () => {
    // Guards against a future field being added to ProductionConfig as a
    // silently-optional dependency: these are the seams with no in-repo
    // implementation, and the list is the contract.
    expect(REQUIRED_INJECTED_CONFIG).toContain('alpacaDataClient');
    expect(REQUIRED_INJECTED_CONFIG).toContain('heartbeatChannel');
    expect(REQUIRED_INJECTED_CONFIG).toContain('orphanAlerts');
    expect(new Set(REQUIRED_INJECTED_CONFIG).size).toBe(REQUIRED_INJECTED_CONFIG.length);
  });
});
