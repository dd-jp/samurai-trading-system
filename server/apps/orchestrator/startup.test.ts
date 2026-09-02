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
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TRADER_CONFIG } from '../../pipeline/trader/index.js';
import {
  GdeltGkgClient,
  MiArchiveStore,
  PolymarketClient,
} from '../../providers/market-intelligence/index.js';
import { TokenBucket } from '../../shared/index.js';
import { openSharedStore, sharedStorePath } from '../../shared/store/index.js';
import {
  assertStorePathMatchesMode,
  DEFAULT_UNIVERSE,
  missingCredentialEnvVars,
  paperStartingProfile,
  SMOKE_TEST_UNIVERSE,
  startFromEnvironment,
  startingProfileForMode,
} from './index.js';
import type { Logger } from './types.js';

/**
 * A GDELT client that reaches no network.
 *
 * `start()` fires the first GDELT poll immediately, and unlike every other
 * vendor client here GDELT needs no credentials — so without this the suite
 * really did download a live 3.4MB batch and archive 200 real rows on every
 * run. Every `startFromEnvironment` call below passes it.
 *
 * The pacing override is not a detail. One client instance is shared by every
 * boot in this file, and the shipped pacing is `capacity: 2,
 * refillPerSecond: 0.2` — two tokens, then one per five seconds. That is the
 * right pace for a real vendor and pure coupling for a stub that throws before
 * it reaches a socket: from the third boot onward each poll parked ~4.6s in
 * `rateLimiter.acquire()`, and once shutdown began draining the in-flight poll
 * (#556) that wait became test wall-clock. The file went from 433ms to 20.5s
 * and the seventh test failed on CI at 4998ms against a 5000ms budget — a test
 * that asserts nothing about GDELT, failing because of how many boots preceded
 * it. Pacing a stub buys nothing; the fence below is what keeps the suite
 * offline.
 */
const offlineGdeltClient = new GdeltGkgClient({
  rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  fetchImpl: (async () => {
    throw new Error('offline: the test suite must not reach GDELT');
  }) as unknown as typeof fetch,
});

/**
 * The same treatment for Polymarket (#504), and for the same reason: its read
 * APIs need no key, so nothing else gates a boot from reaching the live vendor.
 * The composition root builds this agent unconditionally and fires it once from
 * `start()`, so every `startFromEnvironment` call here must inject it.
 */
const offlinePolymarketClient = new PolymarketClient({
  rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  fetchImpl: (async () => {
    throw new Error('offline: the test suite must not reach Polymarket');
  }) as unknown as typeof fetch,
});

/**
 * The backstop for the line above, and it has already earned its keep.
 *
 * Injecting the stub per call site is a rule a new test can forget — and one
 * did: #695 added a twelfth `startFromEnvironment` call while this branch was
 * in flight, and the rebase produced a test that downloads a live batch with
 * every gate still green. Nothing in the type system catches it, because
 * `gdeltClient` is optional by design. So the host itself is refused here: any
 * call site that forgets the stub fails loudly instead of reaching the network.
 */
const realFetch = globalThis.fetch;
let reachedGdelt: string | undefined;
/** Hosts this file tried to reach that nothing here accounts for (#701). */
const escapedToNetwork = new Set<string>();

/**
 * Alpaca's canned refusal, served without leaving the process (#701).
 *
 * The status is the one the venue returns for an unauthenticated request, so
 * reconcile takes the same path it takes in production with a wrong key. That
 * matters because a real 401 is indistinguishable from a fence: if a VALID key
 * ever reached CI, these tests would stop being refused and start reading a
 * live account, and nothing in the suite would look different.
 *
 * A real `Response` rather than a cast literal, so touching `headers`,
 * `clone()` or `arrayBuffer()` behaves instead of throwing an opaque TypeError
 * far from the cause.
 */
function alpacaUnauthorized(): Response {
  return new Response('{"message":"unauthorized"}', {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  });
}

/** Host of `url`, or `''` when it will not parse — never the full URL (#701). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

beforeAll(() => {
  // `init` is deliberately absent: there is no longer any path that forwards a
  // request onward, so nothing here has anything to forward it WITH. The unused
  // parameter was the last trace of the pass-through this fence replaced.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    // Each shape read explicitly: `String(new Request(url))` is the useless
    // '[object Request]', which contains no host and would walk straight past
    // this fence. A backstop that a caller can route around by passing a
    // different-but-equivalent argument type is not a backstop.
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input);
    if (url.includes('gdeltproject.org')) {
      // Recorded, not thrown. Throwing here proves nothing: the poll is fired
      // as `void refresh(...)` and `refresh` never throws by contract, so the
      // rejection is swallowed into a warn log and every test still passes —
      // which is exactly how the original defect stayed invisible.
      reachedGdelt = url;
      throw new Error('offline: the test suite must not reach GDELT');
    }
    // Alpaca is ANSWERED rather than recorded as an escape. Unlike the GDELT
    // case this is not a forgotten stub: startup's reconcile is supposed to ask
    // the broker, and the assertions below depend on it having asked. What must
    // not happen is the asking leaving the machine.
    //
    // Matched on the HOST, never `url.includes('alpaca.markets')`. A substring
    // test also matches the string appearing in some other host's path or query
    // — which would hand that host a canned 401 and record no escape, the exact
    // false-green accounting this fence exists to prevent. The GDELT branch
    // above keeps its substring test on purpose: it RECORDS and throws, so its
    // false positive is loud, where this branch's would be silent.
    const host = hostOf(url);
    if (host === 'alpaca.markets' || host.endsWith('.alpaca.markets')) {
      return alpacaUnauthorized();
    }

    // Default DENY, which is the change #701 is really asking for. This used to
    // be `return realFetch(input, init)` — an allow-list of two hosts with the
    // whole internet behind it, so a new vendor client added to startup would
    // silently begin making live calls from a unit suite and every gate would
    // stay green. Recorded rather than only thrown, for the reason the GDELT
    // branch is: a caller that swallows rejections would otherwise hide it.
    //
    // Host only, in the record AND in the message. Market-data vendors commonly
    // put the API key in the query string, and this error goes to CI logs.
    const escaped = host === '' ? '<unparseable URL>' : host;
    escapedToNetwork.add(escaped);
    throw new Error(`offline: the test suite must not reach ${escaped}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (reachedGdelt !== undefined) {
    throw new Error(
      `startup.test.ts reached ${reachedGdelt} — a startFromEnvironment call is missing ` +
        '`gdeltClient: offlineGdeltClient`.',
    );
  }
  if (escapedToNetwork.size > 0) {
    throw new Error(
      `startup.test.ts tried to reach ${[...escapedToNetwork].join(', ')} — a unit suite must ` +
        'not depend on a third party being reachable. Stub the client, or answer the host in ' +
        'the fence above the way Alpaca is answered (#701).',
    );
  }
});

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
  'NOUS_API_KEY',
  'NOUS_BASE_URL',
  'SAMURAI_SENTIMENT',
  'NODE_ENV',
  // #330 (PR #447 review): the store path is keyed off SAMURAI_MODE now, and
  // the test below sets it. Restoring it at file scope for `NODE_ENV`'s reason
  // — vitest reuses a worker across files, and a leaked mode would repoint
  // every later store open in that worker.
  'SAMURAI_MODE',
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
  // #511: the live profile's three variables. In this list for the same reason
  // as `SAMURAI_MODE` — a leaked live key or ceiling would change what a later
  // test in the same worker exercises. Every value set below is a stub.
  'SAMURAI_LIVE_MAX_CAPITAL_USD',
  'ALPACA_LIVE_API_KEY',
  'ALPACA_LIVE_API_SECRET',
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
  // See #691: the composition root now refuses a trader config whose
  // `flatten_before_close_ms` would silently disable flat-by-close, so this one
  // cannot stay an empty cast either. The real defaults, which is also what
  // `paperStartingProfile` spreads.
  traderConfig: DEFAULT_TRADER_CONFIG as never,
  riskConfig: {} as never,
  // See #434: the composition root reads the automation dial to refuse a
  // HITL-engaging config, so this one cannot stay an empty cast.
  verdictConfig: { automation_level: { crypto: 'auto', stocks: 'auto' } } as never,
  executionConfig: {} as never,
  correlationConfig: {} as never,
  // Like `verdictConfig` above, and for the same class of reason: since #634
  // `CircuitBreakers` validates its hysteresis band (`recovery_drawdown_pct <
  // max_drawdown_pct`) at construction, so an empty cast is a config the
  // composition root cannot build.
  breakerConfig: {
    daily_loss_pct: 0.05,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.3,
    max_consecutive_losses: 5,
    volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
    auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
  } as never,
  costConfig: {} as never,
  ciiConsumerConfig: { pollIntervalMs: 60_000 } as never,
  // #738: `universe` joined `REQUIRED_INJECTED_CONFIG` — these cases are
  // about credential/wiring refusals, not about which instruments trade, so
  // they carry the same narrow default the smoke harness does.
  universe: SMOKE_TEST_UNIVERSE,
};

describe('startFromEnvironment — real construction path', () => {
  it('assembles and starts the whole orchestrator from credentials alone', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';

    // No transports, no clients, no account-state or volatility provider —
    // only the tuning configs the operator genuinely owns.
    const orchestrator = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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

  it('refuses to start on a book holding pre-#686 idempotency keys', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';

    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO open_positions (
         idempotency_key, debate_id, instrument, asset_class, side, intent_type,
         requested_size, filled_size, avg_entry_price, stop, target, order_state,
         broker_order_ids, opened_at, decision_timestamp, key_scheme
       ) VALUES ('pre-686', 'd', '3USL', 'stocks', 'buy', 'entry',
         1, 1, 100, 95, 110, 'filled', '[]', '2026-08-14T09:00:00.000Z',
         '2026-08-14T09:00:00.000Z', 1)`,
    ).run();

    // The guard's own tests cover the query; this one covers the WIRING —
    // credentials that would otherwise start cleanly, and a store the caller
    // injected, which is the path a soak restart actually takes. A guard
    // nothing calls is this repo's dominant defect class.
    const error = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db,
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('Refusing to start');
    expect(error.message).toContain('pre-686');
  });

  it('fails with an actionable message when Alpaca credentials are absent', async () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;

    const error = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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
    // `NOUS_API_KEY`, on subsequent runs.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    delete process.env.NOUS_API_KEY;
    delete process.env.NOUS_BASE_URL;

    const error = startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    return error.then((e) => {
      expect(e.message).toContain('ALPACA_API_KEY');
      expect(e.message).toContain('ALPACA_API_SECRET');
      expect(e.message).toContain('NOUS_API_KEY');
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
    process.env.NOUS_API_KEY = 'dummy-nous-not-a-credential';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';
  });

  it('boots to a running tick loop and logs `orchestrator started`', async () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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
      //
      // #738 narrowed `DEFAULT_UNIVERSE` further, to equities-only — crypto
      // is out of Samurai's scope, so the "FULL" universe this line names no
      // longer includes BTC-USD/ETH-USD.
      expect(started?.payload).toMatchObject({
        mode: 'paper',
        universe: ['SPY', 'QQQ', 'AAPL', 'TSLA'],
      });

      // ...and the equity half is genuinely wired, not merely listed. Before
      // #738 the volatility breaker's "no instruments configured for asset
      // class" warn fired for `stocks`; after #738 it fires for `crypto`
      // instead — crypto genuinely has zero instruments in the production
      // schedule now, so that warn is the CORRECT state, not a gap.
      const inertClassWarn = entries.find((entry) =>
        entry.message.includes('no instruments configured for asset class'),
      );
      expect(inertClassWarn?.payload).toMatchObject({ asset_class: 'crypto' });
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

    // `sharedStorePath()` returns a path RELATIVE to the process cwd, so this
    // test used to open — and then `rmSync` — the real `data/samurai-paper.sqlite`
    // in whatever checkout vitest was invoked from. On 2026-08-06 that unlinked
    // the store of a live paper run mid-flight: the orchestrator and dashboard
    // kept writing to the now-nameless inode, so nothing appeared broken until
    // a restart would have dropped the whole session, and `llm_spend` (the
    // table ADR-0008's $50 cap is measured over) reset to zero with it. Any
    // `yarn test` — including the one inside `yarn precommit` — was enough.
    //
    // Relocating the cwd rather than the assertion is deliberate: what is under
    // test is that the path is derived from SAMURAI_MODE and not NODE_ENV, and
    // that only holds if the production resolution runs untouched. So the test
    // moves itself somewhere destroying `data/` is harmless instead of moving
    // the code somewhere it can be observed.
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-startup-')));
    const cwd = process.cwd();
    process.chdir(sandbox);

    // Every path below is inside the try, so a construction failure restores
    // the cwd too rather than stranding the rest of the worker in a directory
    // this test is about to delete.
    let orchestrator: Awaited<ReturnType<typeof startFromEnvironment>> | undefined;

    try {
      // Deliberately NOT passing `db` — resolving the path internally is the
      // whole point of this test.
      orchestrator = await startFromEnvironment({
        ...paperStartingProfile('paper'),
        logger,
        gdeltClient: offlineGdeltClient,
        polymarketClient: offlinePolymarketClient,
      });

      expect(existsSync(join(sandbox, 'data/samurai-paper.sqlite'))).toBe(true);
      expect(existsSync(join(sandbox, 'data/samurai-staging.sqlite'))).toBe(false);
      // And the warning this replaces is gone rather than merely quiet.
      expect(entries.find((entry) => entry.message.includes('#330'))).toBeUndefined();
    } finally {
      await orchestrator?.stop();
      // Restore the cwd BEFORE removing the sandbox: every later test in this
      // worker resolves its own relative paths against it, and a process whose
      // cwd has been deleted resolves nothing at all.
      process.chdir(cwd);
      rmSync(sandbox, { recursive: true, force: true });
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
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
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

  it('refuses to boot the shipped PAPER profile into live mode', () => {
    // `mode` is refused at the profile, before `startFromEnvironment` is even
    // called — so no store is opened and no client is constructed. Live stays
    // reachable, but only through `liveStartingProfile` or a caller passing
    // values somebody tuned.
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
  });

  it('never reads the live key pair on a paper boot', () => {
    // #511's paper-side acceptance criterion, and the blast-radius check: a
    // garbage live-only variable must not be able to fail a paper start.
    process.env.SAMURAI_MODE = 'paper';
    process.env.ALPACA_LIVE_API_KEY = '';
    process.env.ALPACA_LIVE_API_SECRET = 'not-a-key';
    process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = 'nonsense';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper')).not.toContain('ALPACA_LIVE_API_KEY');
    expect(() => paperStartingProfile('paper')).not.toThrow();
    expect(startingProfileForMode('paper')).toMatchObject({ mode: 'paper' });
  });
});

/**
 * #511 — the composition root's live path, end to end, with stub credentials.
 *
 * What this proves: `SAMURAI_MODE=live` plus the three declared variables
 * reaches a running orchestrator whose broker client is pointed at
 * `api.alpaca.markets`, and whose config carries the declared ceiling.
 *
 * What it deliberately does NOT prove, and cannot without real keys: that the
 * credentials authenticate, or that Alpaca would accept an order. Nothing here
 * makes a network call — the store is in-memory and empty, so the startup
 * reconcile has no lots, and `stop()` runs long before the first tick.
 *
 * Nothing in this file writes `.env.local` or leaves `SAMURAI_MODE=live` behind;
 * the file-level `afterEach` restores all three variables.
 */
describe('startFromEnvironment — the live profile (#511)', () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
    process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    process.env.ALPACA_LIVE_API_KEY = 'dummy-live-key-not-a-credential';
    process.env.ALPACA_LIVE_API_SECRET = 'dummy-live-secret-not-a-credential';
    process.env.NOUS_API_KEY = 'dummy-nous-not-a-credential';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';
    process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = '2000';
  });

  it('boots a live-configured orchestrator pointed at the live Alpaca host', async () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...startingProfileForMode('live', logger),
      // #989: `liveStartingProfile` resolves to `DEFAULT_UNIVERSE`, which
      // still trades `'SPY'` directly (pre-#751's LSE-only cutover) — the
      // EXACT condition `buildProductionComponents`'s new collision guard
      // refuses to boot. This test is about the live-host wiring
      // (`brokerLine`/`profileWarn` below), not about which universe is
      // configured, so it drops `'SPY'` rather than weakening the guard.
      universe: DEFAULT_UNIVERSE.filter((instrument) => instrument.asset !== 'SPY'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      logger,
    });

    try {
      const started = entries.find((entry) => entry.message === 'orchestrator started');
      expect(started?.payload).toMatchObject({ mode: 'live' });

      // The claim that matters: the broker client this root built talks to the
      // LIVE host. `buildDefaultAlpacaBrokerClient` logs the resolved base URL,
      // which is the only place an operator can read it.
      const brokerLine = entries.find((entry) =>
        entry.message.includes('LIVE Alpaca broker client'),
      );
      expect(brokerLine?.level).toBe('warn');
      expect(brokerLine?.payload).toMatchObject({
        mode: 'live',
        environment: 'live',
        baseUrl: 'https://api.alpaca.markets',
      });

      // ...and the profile's own warn, naming the gates, reached the same log.
      const profileWarn = entries.find((entry) => entry.message.includes('LIVE STARTING PROFILE'));
      expect(profileWarn?.level).toBe('warn');
      expect(profileWarn?.payload).toMatchObject({ capital_ceiling_usd: 2_000 });

      // No credential reaches the log, ever.
      expect(JSON.stringify(entries)).not.toContain('dummy-live-key-not-a-credential');
      expect(JSON.stringify(entries)).not.toContain('dummy-live-secret-not-a-credential');
    } finally {
      await orchestrator.stop();
    }
  });

  it(
    'refuses to boot the REAL default live entrypoint (#989) — `startingProfileForMode' +
      "('live')` (`liveStartingProfile` under the hood) resolves to `DEFAULT_UNIVERSE`, " +
      "which still trades 'SPY' directly, with no `universe` override at all. The test " +
      "above deliberately drops 'SPY' from the universe to isolate the live-host wiring " +
      'it is about; this one proves the collision guard actually protects the default ' +
      'entrypoint an operator would reach by just setting SAMURAI_MODE=live, not only the ' +
      'synthetic configs `production.test.ts` constructs by hand',
    async () => {
      const error = await startFromEnvironment({
        ...startingProfileForMode('live'),
        db: openSharedStore(':memory:'),
        miArchive: new MiArchiveStore(),
        gdeltClient: offlineGdeltClient,
        polymarketClient: offlinePolymarketClient,
      }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

      expect(error.message).toMatch(/collides with the outside-benchmark path/);
    },
  );

  it.each([
    '',
    '  ',
    '0',
    '-500',
    'abc',
  ])('refuses to boot live with a capital ceiling of %j', (ceiling) => {
    process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = ceiling;

    // Refused at the profile, before any store is opened or client built.
    expect(() => startingProfileForMode('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });

  it('refuses to boot live with the ceiling unset', () => {
    delete process.env.SAMURAI_LIVE_MAX_CAPITAL_USD;

    expect(() => startingProfileForMode('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });

  it.each([
    'ALPACA_LIVE_API_KEY',
    'ALPACA_LIVE_API_SECRET',
  ])('refuses to boot live when %s is absent, with no fallback to the paper pair', async (name) => {
    delete process.env[name];

    const error = await startFromEnvironment({
      ...startingProfileForMode('live'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    // The paper pair is still set, so a fallback would have started a live
    // process authenticated against the wrong account.
    expect(error.message).toContain(name);
    expect(missingCredentialEnvVars({}, 'log-only', 'live')).toContain(name);
  });

  it('keeps live state in its own store file, so a live run cannot inherit paper positions', () => {
    // #168/#330's invariant, re-asserted because #511 is the change that makes
    // the mode switch reachable at all. `resolveStoreMode` throws on an unset
    // mode and the path is `data/samurai-{mode}.sqlite`, file per mode.
    process.env.SAMURAI_MODE = 'live';
    expect(sharedStorePath()).toContain('samurai-live.sqlite');

    process.env.SAMURAI_MODE = 'paper';
    expect(sharedStorePath()).toContain('samurai-paper.sqlite');

    // And the composition root refuses a mode that disagrees with the path it
    // resolved, rather than writing live state into the paper database.
    expect(() =>
      assertStorePathMatchesMode({ dbPath: 'data/samurai-paper.sqlite', mode: 'live' }),
    ).toThrow(/samurai-paper.sqlite/);
  });
});
