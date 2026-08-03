/**
 * The assertion the whole "orchestrator can start" claim rests on.
 *
 * `index.test.ts` proves `REQUIRED_INJECTED_CONFIG` no longer LISTS the
 * transports. That is a different statement from "construction succeeds past
 * the guard", and the gap between them is where this would quietly fail:
 * every default this composition root now builds (both Alpaca clients, the
 * account-state provider, the volatility provider, the three log channels)
 * runs AFTER the guard, so a broken default would surface as a deep stack
 * trace rather than the legible message the guard was written to give.
 */
import { openSharedStore } from '../shared/store/index.js';
import { startFromEnvironment } from './index.js';

/**
 * The eight per-stage config objects — all that remains required. Stubbed
 * rather than realistic: this test asks whether the process assembles, not
 * whether it trades well, and no tick runs before `stop()`.
 */
const STAGE_CONFIGS = {
  traderConfig: {} as never,
  riskConfig: {} as never,
  verdictConfig: {} as never,
  executionConfig: {} as never,
  correlationConfig: {} as never,
  breakerConfig: {} as never,
  costConfig: {} as never,
  ciiConsumerConfig: { pollIntervalMs: 60_000 } as never,
};

describe('startFromEnvironment — real construction path', () => {
  const saved = {
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_API_SECRET,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };

  afterEach(() => {
    restore('ALPACA_API_KEY', saved.key);
    restore('ALPACA_API_SECRET', saved.secret);
    restore('ANTHROPIC_API_KEY', saved.anthropic);
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  it('assembles and starts the whole orchestrator from credentials alone', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    // No transports, no clients, no account-state or volatility provider —
    // only the tuning configs the operator genuinely owns.
    const orchestrator = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
    });

    try {
      // Reaching here means the orphan scan and the startup reconcile both ran
      // and the tick loop plus fill-sync poll are armed.
      expect(orchestrator.tickRunner).toBeDefined();
      expect(orchestrator.broker).toBeDefined();
    } finally {
      await orchestrator.stop();
    }
  });

  it('fails with an actionable message when Alpaca credentials are absent', async () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;

    const error = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
    }).catch((e: unknown) => e as Error);

    // Names the variable and how to supply it. The seams guard used to catch
    // this case by demanding an injected client; now that the client is built
    // here, the client's own error carries that weight instead — so this
    // asserts the replacement is at least as legible as what it replaced.
    expect(error.message).toContain('ALPACA_API_KEY');
    expect(error.message).toContain('.env.local');
  });
});
