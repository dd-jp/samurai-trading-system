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
import { existsSync, rmSync } from 'node:fs';
import { openSharedStore } from '../shared/store/index.js';
import { paperStartingProfile, startFromEnvironment } from './index.js';
import type { Logger } from './types.js';

/**
 * The resolve arm of the `.then(…, …)` pairs below, which exist so that
 * `error` types as `Error` rather than `Error | ProductionOrchestrator` — the
 * union the old `.catch(e => e as Error)` produced, on which `.message` does
 * not exist.
 *
 * Throwing rather than returning is the point. Every assertion here reads
 * `error.message`; if the guard under test ever stopped rejecting, the old
 * form handed back a live orchestrator whose `.message` is `undefined`, and
 * `expect(undefined).toContain(...)` fails with a type error about the
 * matcher instead of naming what actually broke.
 */
function resolvedUnexpectedly(): never {
  throw new Error('startFromEnvironment resolved, but this test requires it to reject');
}

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
  // #322: every test in this file drives the real construction path, and that
  // path now refuses to start until the operator has said where alerts go.
  // Defaulted to `log-only` per test below; the Telegram three are cleared so
  // an ambient value on the developer's machine cannot change what these
  // tests exercise.
  'SAMURAI_ALERTS',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ALLOWED_USER_IDS',
  // #342: the heartbeat's own destination, separate from the escalation chat.
  'TELEGRAM_HEARTBEAT_CHAT_ID',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    savedEnv.set(name, process.env[name]);
  }
  // The attended posture, named explicitly (#322) — which is the only way it
  // can be reached. Individual tests override it to prove the refusals.
  process.env.SAMURAI_ALERTS = 'log-only';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;
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
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

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
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

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
      // #381's first acceptance criterion, asserted where an operator actually
      // reads it: the startup line names the FULL ADR-0001 universe, not the
      // BTC-USD smoke set it used to log. This is the end-to-end check that
      // the profile's universe survives `startFromEnvironment` — a live paper
      // run that logs `universe: ["BTC-USD"]` is the bug this replaces.
      expect(started?.payload).toMatchObject({
        mode: 'paper',
        universe: ['SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD'],
      });

      // ...and the equity half is genuinely wired, not merely listed. The
      // volatility breaker warns "no instruments configured for asset class"
      // once per class it cannot read, which is exactly what a live paper run
      // emitted for `stocks` before this change.
      const inertClassWarn = entries.find((entry) =>
        entry.message.includes('no instruments configured for asset class'),
      );
      expect(inertClassWarn).toBeUndefined();
    } finally {
      // The loop, the heartbeat and the fill poll are all armed by `start()`;
      // leaving them running would leak timers into the rest of the suite.
      await orchestrator.stop();
    }
  });

  it('opens the file named after the TRADING MODE, whatever NODE_ENV says (#330)', async () => {
    // The wiring assertion for #330, distinct from the predicate's own unit
    // tests: those prove the rule, this proves `startFromEnvironment` resolves
    // the path it is about to open from the mode. Re-keying it back to
    // NODE_ENV is invisible to the unit tests and fails here.
    //
    // `staging` is set precisely to show it does NOT reach the filename: before
    // #330 this run wrote `samurai-staging.sqlite`, which is the file a later
    // live run on the same host would have inherited paper state from.
    process.env.NODE_ENV = 'staging';
    process.env.SAMURAI_MODE = 'paper';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    // Deliberately NOT passing `db` — resolving the path internally is the
    // whole point of this test.
    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      logger,
    });

    try {
      expect(existsSync('data/samurai-paper.sqlite')).toBe(true);
      expect(existsSync('data/samurai-staging.sqlite')).toBe(false);
      // And the warning this replaces is gone rather than merely quiet.
      expect(entries.find((entry) => entry.message.includes('#330'))).toBeUndefined();
    } finally {
      await orchestrator.stop();
      rmSync('data/samurai-paper.sqlite', { force: true });
      rmSync('data/samurai-paper.sqlite-wal', { force: true });
      rmSync('data/samurai-paper.sqlite-shm', { force: true });
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

  it('refuses to boot at all when SAMURAI_ALERTS is unset (#322)', async () => {
    // The ticket's core claim: there is no path from an unconfigured host to a
    // running process whose alerts all go to a log nobody reads. Credentials
    // are present here, so the only thing standing between this call and a
    // started orchestrator is the alerts decision.
    delete process.env.SAMURAI_ALERTS;

    const error = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('SAMURAI_ALERTS');
  });

  it('names every missing Telegram variable when the unattended mode is selected', async () => {
    // SECURITY: the bot token is set and the other two are not. The message
    // must name what is missing and carry no credential — it is written
    // straight to stderr by the entrypoint's startup catch.
    const sentinel = '1234567:AA-not-a-real-bot-token-sentinel';
    process.env.SAMURAI_ALERTS = 'telegram';
    process.env.TELEGRAM_BOT_TOKEN = sentinel;

    const error = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('TELEGRAM_CHAT_ID');
    expect(error.message).toContain('TELEGRAM_ALLOWED_USER_IDS');
    // #342: the heartbeat's separate destination is named in the same breath,
    // rather than discovered one variable later. Matched inside the
    // parenthesised MISSING list rather than anywhere in the message — the
    // advice paragraph that follows also mentions the variable, and asserting
    // on that would pass even if the pre-flight stopped requiring it.
    expect(error.message).toMatch(
      /required credential\(s\) are not set \([^)]*TELEGRAM_HEARTBEAT_CHAT_ID[^)]*\)/,
    );
    expect(error.message).not.toContain(sentinel);
    // The token IS set, so it must not be reported as missing.
    expect(error.message).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('boots with the real push transport under SAMURAI_ALERTS=telegram', async () => {
    // The other half of #322: the unattended posture actually assembles.
    // Nothing here reaches Telegram — the client is constructed, no poll loop
    // is started, and `stop()` runs long before the first 15-minute heartbeat.
    process.env.SAMURAI_ALERTS = 'telegram';
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-token-not-a-credential';
    process.env.TELEGRAM_CHAT_ID = '-1001234567890';
    process.env.TELEGRAM_ALLOWED_USER_IDS = '42';
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = '-1009876543210';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      logger,
    });

    try {
      expect(entries.some((e) => e.message.includes('SAMURAI_ALERTS=telegram'))).toBe(true);
      expect(entries.some((e) => e.message === 'orchestrator started')).toBe(true);
      // And the log-only warning is NOT emitted — the two are mutually
      // exclusive, so this fails if the telegram branch silently fell back.
      expect(entries.some((e) => e.message.includes('SAMURAI_ALERTS=log-only'))).toBe(false);
      // The bot token must not reach any log line: it is a bearer credential
      // for the whole bot and sits in every request URL.
      expect(JSON.stringify(entries)).not.toContain('dummy-token-not-a-credential');

      // The assertion that actually proves the wiring, rather than proving a
      // log line: drive the composed `Heartbeat` and watch the request leave.
      // A startup log claiming `telegram` while the orchestrator was still
      // handed `LoggingHeartbeatChannel` would pass every check above and fail
      // this one. Transport stubbed — nothing reaches Telegram.
      const fetchStub = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: {} }),
      });
      vi.stubGlobal('fetch', fetchStub);
      try {
        await orchestrator.heartbeat.emit({ now: () => new Date('2026-08-04T10:00:00Z') });

        expect(fetchStub).toHaveBeenCalledTimes(1);
        const [, init] = fetchStub.mock.calls[0] as [string, { body: string }];
        // #342: the HEARTBEAT chat, not the escalation chat. This is the
        // end-to-end half of the separation — a shipped entrypoint that still
        // pointed both at TELEGRAM_CHAT_ID would fail here.
        expect(JSON.parse(init.body)).toMatchObject({ chat_id: '-1009876543210' });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
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
