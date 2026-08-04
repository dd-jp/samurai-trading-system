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
import { rmSync } from 'node:fs';
import { openSharedStore } from '../shared/store/index.js';
import { paperStartingProfile, startFromEnvironment } from './index.js';
import type { Logger } from './types.js';

/**
 * Every environment variable this file mutates, saved and restored around
 * EVERY test in the file — one hook pair at file scope rather than a
 * hand-rolled pair per `describe`.
 *
 * Same shape as `index.test.ts`, and the reason is containment rather than
 * tidiness. These tests delete credentials and repoint `NODE_ENV`; vitest
 * reuses a worker across files, so anything left behind is inherited by
 * whatever runs next in that worker. Per-describe hooks make that correctness
 * depend on which describes actually ran — which is not a property that
 * survives `-t` filtering, `--shard`, or someone reordering the file.
 * Restoring at file scope makes it depend on nothing.
 *
 * `NODE_ENV` is in the list because the #330 warning test repoints it, and it
 * is the single most consequential variable here: `sharedStorePath()` refuses
 * to resolve an unrecognised one, so leaking a bad value fails every later
 * test that opens a store by convention path.
 */
const MUTATED_ENV_VARS = [
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'ANTHROPIC_API_KEY',
  'NODE_ENV',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    savedEnv.set(name, process.env[name]);
  }
});

afterEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

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
  beforeEach(() => {
    // Syntactically valid, functionally worthless: enough to construct the
    // HTTP clients, not enough to authenticate. Real credentials are never
    // required — or wanted — by this suite. Restored by the file-level
    // `afterEach` above, along with everything else these tests touch.
    process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
    process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-not-a-credential';
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

  it('warns at startup that the store path cannot separate paper from live (#330)', async () => {
    // The wiring assertion for #330, distinct from `warnIfStorePathIgnoresMode`'s
    // own unit tests: those prove the predicate, this proves `startFromEnvironment`
    // actually calls it on the path it is about to open. Removing the call is
    // invisible to the unit tests and fails here.
    //
    // `staging` rather than the ambient `test`: it is a real `STORE_ENVIRONMENTS`
    // value that nothing else in the suite writes, so the file this creates
    // cannot collide with another worker's. Restored by the file-level
    // `afterEach`, which is why `NODE_ENV` is in `MUTATED_ENV_VARS`.
    process.env.NODE_ENV = 'staging';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    // Deliberately NOT passing `db` — resolving the path internally is the
    // whole point of this test.
    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      logger,
    });

    try {
      const warning = entries.find((entry) => entry.message.includes('#330'));
      expect(warning?.level).toBe('warn');
      expect(warning?.payload).toMatchObject({
        mode: 'paper',
        db_file: 'samurai-staging.sqlite',
      });
    } finally {
      await orchestrator.stop();
      rmSync('data/samurai-staging.sqlite', { force: true });
      rmSync('data/samurai-staging.sqlite-wal', { force: true });
      rmSync('data/samurai-staging.sqlite-shm', { force: true });
    }
  });

  it('does not warn about a store handle it did not resolve', () => {
    // A caller injecting its own handle gets no warning, because this process
    // does not know what path that handle was opened on — warning about a path
    // it never resolved would be a guess.
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    return startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      logger,
    }).then(async (orchestrator) => {
      try {
        expect(entries.filter((entry) => entry.message.includes('#330'))).toEqual([]);
      } finally {
        await orchestrator.stop();
      }
    });
  });

  it('refuses to boot the shipped profile into live mode', () => {
    // `mode` is refused at the profile, before `startFromEnvironment` is even
    // called — so no store is opened and no client is constructed. Live stays
    // reachable, but only for a caller passing values somebody tuned.
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
  });
});
