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
import { paperStartingProfile, startFromEnvironment } from './index.js';
import type { Logger } from './types.js';

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

  it('names every missing credential in one message, not one per attempt', () => {
    // Regression guard for the pre-flight added in #323. Before it, an
    // unconfigured host learned about `ALPACA_API_KEY` alone — the broker
    // client is simply the first thing `buildProductionComponents`
    // constructs — and only discovered `ALPACA_API_SECRET`, then
    // `ANTHROPIC_API_KEY`, on subsequent runs.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    delete process.env.ANTHROPIC_API_KEY;

    const error = startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
    }).catch((e: unknown) => e as Error);

    return error.then((e) => {
      expect(e.message).toContain('ALPACA_API_KEY');
      expect(e.message).toContain('ALPACA_API_SECRET');
      expect(e.message).toContain('ANTHROPIC_API_KEY');
    });
  });
});

/**
 * The ticket's actual acceptance criterion (#323): not "the guard no longer
 * lists the transports" and not "the profile type-checks", but that the
 * shipped starting profile drives the real construction path all the way to
 * the `orchestrator started` log line.
 *
 * Deliberately NOT proved here, and unprovable without real keys: that the
 * credentials authenticate, that Alpaca accepts an order built from these
 * values, or that any of the numbers are well-chosen. Nothing below makes a
 * network call — the store is empty, so the startup reconcile has no lots to
 * check, and `stop()` runs long before the first 60s tick.
 */
describe('startFromEnvironment — the shipped paper profile', () => {
  const saved = {
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_API_SECRET,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };

  beforeEach(() => {
    // Syntactically valid, functionally worthless: enough to construct the
    // HTTP clients, not enough to authenticate. Real credentials are never
    // required — or wanted — by this suite.
    process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
    process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-not-a-credential';
  });

  afterEach(() => {
    for (const [name, value] of [
      ['ALPACA_API_KEY', saved.key],
      ['ALPACA_API_SECRET', saved.secret],
      ['ANTHROPIC_API_KEY', saved.anthropic],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('boots to a running tick loop and logs `orchestrator started`', async () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      logger,
    });

    try {
      const started = entries.find((entry) => entry.message === 'orchestrator started');
      expect(started).toBeDefined();
      expect(started?.payload).toMatchObject({ mode: 'paper', universe: ['BTC-USD'] });
    } finally {
      // The loop, the heartbeat and the fill poll are all armed by `start()`;
      // leaving them running would leak timers into the rest of the suite.
      await orchestrator.stop();
    }
  });

  it('refuses to boot the shipped profile into live mode', () => {
    // `mode` is refused at the profile, before `startFromEnvironment` is even
    // called — so no store is opened and no client is constructed. Live stays
    // reachable, but only for a caller passing values somebody tuned.
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
  });
});
