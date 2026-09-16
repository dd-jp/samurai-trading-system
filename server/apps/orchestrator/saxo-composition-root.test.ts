/**
 * #1400 — the composition root reaches the Saxo adapter, and only when it is
 * told to.
 *
 * Every case here drives `startFromEnvironment` itself, the function the
 * shipped entrypoint calls. A test that composed its own wiring would prove
 * nothing about what ships — which is the exact shape of the defect this
 * ticket reports: `SaxoBrokerAdapter` was built, tested, and constructed by
 * nothing.
 *
 * The venue is driven against a fixture gateway shaped by
 * docs/research/43-saxo-openapi-order-idempotency.md and
 * docs/research/44-saxo-data-surface.md, so this suite reaches no network. The
 * SAME path was run against the real SIM gateway on 2026-09-11 (doc 44 §6):
 * the resolver, the adapter and the startup reconcile all completed, and the
 * only seams an operator still supplies by hand are `accountState` and
 * `lseMarkClient`, neither of which is missing wiring.
 */

import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type {
  SaxoAssetType,
  SaxoInstrumentDetails,
  SaxoOpenApiClient,
  SaxoOrderRequest,
} from '../../pipeline/execution/index.js';
import { AlpacaBrokerAdapter, SaxoBrokerAdapter } from '../../pipeline/execution/index.js';
import type { LseMarkClient } from '../../providers/market-data-service/index.js';
import { timeframeToMs } from '../../providers/market-data-service/index.js';
import { MiArchiveStore } from '../../providers/market-intelligence/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { startFromEnvironment, startingProfileForMode } from './index.js';
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD, paperStartingProfile } from './paper-profile.js';
import type { AccountFundingSource } from './production/account-state.js';
import { BROKER_VENUE_ENV_VAR, saxoTradeableUniverse } from './production/saxo-venue.js';
import type { ProductionConfig, ProductionOrchestrator } from './production.js';
import { buildTrendingCloses, ConstantResponseLlmClient } from './smoke-run.js';

const NOW = new Date('2026-09-09T10:00:00.000Z');

/**
 * VERIFIED on SIM 2026-09-08 (doc 44 §2.1): every line this pool can trade
 * today is a GBX-quoted, GBP-settled ETP with `PriceToContractFactor` 0.01
 */
function penceDetails(uic: number, assetType: SaxoAssetType): SaxoInstrumentDetails {
  return {
    Uic: uic,
    AssetType: assetType,
    CurrencyCode: 'GBP',
    PriceCurrency: 'GBX',
    PriceToContractFactor: 0.01,
  };
}

interface FixtureGateway extends SaxoOpenApiClient {
  readonly placed: SaxoOrderRequest[];
}

function fixtureSaxoGateway(): FixtureGateway {
  const placed: SaxoOrderRequest[] = [];
  return {
    placed,
    getInstrumentDetails: async (uic, assetType) => penceDetails(uic, assetType),
    placeOrder: async (request) => {
      placed.push(request);
      return {
        OrderId: `${placed.length}00`,
        ExternalReference: request.ExternalReference,
        Orders: (request.Orders ?? []).map((leg, index) => ({
          OrderId: `${placed.length}0${index + 1}`,
          ExternalReference: leg.ExternalReference,
        })),
      };
    },
    cancelOrder: async () => undefined,
    listOpenOrders: async () => [],
    listOrderActivities: async () => [],
    listNetPositions: async () => [],
  };
}

/**
 * A pence-quoting vendor stand-in. The real LSE vendor is still an open owner
 * decision (#895), so nothing on this branch can boot the mark side for real —
 * which is why the ticket's "no refusal that traces to missing wiring" is
 * asserted about the BROKER seam here, not about a priced tick.
 */
function fixtureLseMarkClient(): LseMarkClient {
  return {
    vendor: 'fixture-lse',
    getBars: async (_symbol, _timeframe, asOf, limit) => ({
      currency: 'GBX',
      candles: Array.from({ length: limit }, (_, index) => ({
        open_time: new Date(asOf.getTime() - (limit - index) * 60_000),
        open: 3115,
        high: 3120,
        low: 3110,
        close: 3115,
        volume: 10_000,
      })),
    }),
    getLatestQuote: async () => ({
      currency: 'GBX',
      price: 3115,
      bid: 3114,
      ask: 3116,
      observed_at: NOW,
    }),
  };
}

/**
 * The smoke gate's series is expressed in abstract units; this is what one of
 * them is worth in pence, chosen so the mark lands at £32 — the order of
 * magnitude the pool quotes at (3KOR was £20.49 on SIM, doc 44 §6.6).
 *
 * It is load-bearing, not cosmetic. Sizing is risk-budget-over-stop-distance
 * and then floored to whole shares (#1216), and the stop distance is
 * `atr_k x ATR`, which scales WITH the price. At the smoke fixture's own £159
 * the same series sizes to 0 shares and the Trader skips on
 * `below_min_notional` — a £32 line clears it with room.
 */
const PENCE_PER_SERIES_UNIT = 20;

/** The mark the tick trades against, in the series' own units */
const MARK_PRICE_UNITS = 160;

/**
 * The same pence-quoting seam, carrying the series the offline smoke gate
 * already proves reaches a `go` (`buildTrendingCloses`) — scaled x100 into
 * GBX, so the GBX->GBP conversion runs on every bar of it.
 *
 * A flat series is not an oversight to fix by tuning: `fixtureLseMarkClient`'s
 * constant 3115 short-circuits at `trader: no_trade`, and a MONOTONIC ramp
 * pins RSI at 100 and makes the technical analyst read neutral (#625), so the
 * only `go` reachable from one is the mediator-override branch. Rising WITH
 * pullbacks is what makes the desk agree.
 */
function trendingLseMarkClient(now: Date): LseMarkClient {
  return {
    vendor: 'fixture-lse-trending',
    getBars: async (_symbol, timeframe, asOf, limit) => {
      const stepMs = timeframeToMs(timeframe);
      return {
        currency: 'GBX',
        candles: buildTrendingCloses(limit, MARK_PRICE_UNITS - 1).map((close, index) => ({
          open_time: new Date(asOf.getTime() - (limit - index) * stepMs),
          open: close * PENCE_PER_SERIES_UNIT,
          high: (close + 2) * PENCE_PER_SERIES_UNIT,
          low: (close - 2) * PENCE_PER_SERIES_UNIT,
          close: close * PENCE_PER_SERIES_UNIT,
          volume: 10_000,
        })),
      };
    },
    getLatestQuote: async () => ({
      currency: 'GBX',
      price: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT,
      bid: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT - 5,
      ask: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT + 5,
      observed_at: now,
    }),
  };
}

function offlineInjections(db: StoreHandle): Partial<ProductionConfig> {
  return {
    db,
    logger: { log: () => undefined },
    miArchive: new MiArchiveStore(':memory:'),
    llmClient: {
      complete: async () => ({ text: '{}' }),
    } as unknown as NonNullable<ProductionConfig['llmClient']>,
    // Both MI vendors reach the live network from the composition root's own
    // boot-time refresh; the suite's network guard is what catches it
    gdeltClient: {
      fetchLatestBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
      fetchBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
    } as unknown as NonNullable<ProductionConfig['gdeltClient']>,
    polymarketClient: {
      fetchEventMarket: async () => undefined,
      fetchPriceHistory: async () => [],
    },
    /**
     * REQUIRED by the Saxo venue, not a convenience: the venue refuses to
     * boot without a funding read of its own rather than size a GBP book off
     * Alpaca's USD `GET /v2/account` (#949). Since #1509 an `accountFunding`
     * over `GET /port/v1/balances/me` satisfies the same refusal; this
     * fixture supplies the whole provider instead, so no wire client is
     * needed here.
     *
     * The REAL `AccountStateProvider` shape, uncast: a cast fixture here hid
     * the ceiling defect round 1 found, because an invented `equity`/
     * `currency` pair reads as a GBP account the sizing path never sees.
     */
    accountState: {
      getAccountState: async () => ({
        cash: 1_400,
        peak_equity: 1_400,
        daily_basis: {
          crypto: { known: false, reason: 'crypto is out of scope' },
          stocks: { known: true, open_equity: 1_400, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 1_400, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    },
  };
}

describe('startFromEnvironment (broker venue selection, #1400)', () => {
  const savedVenue = process.env[BROKER_VENUE_ENV_VAR];
  const savedAlerts = process.env.SAMURAI_ALERTS;
  const savedMode = process.env.SAMURAI_MODE;
  let db: StoreHandle;
  let started: ProductionOrchestrator | undefined;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    started = undefined;
    process.env.SAMURAI_ALERTS = 'log-only';
    process.env.SAMURAI_MODE = 'paper';
  });

  afterEach(async () => {
    await started?.stop();
    db.close();
    if (savedVenue === undefined) delete process.env[BROKER_VENUE_ENV_VAR];
    else process.env[BROKER_VENUE_ENV_VAR] = savedVenue;
    if (savedAlerts === undefined) delete process.env.SAMURAI_ALERTS;
    else process.env.SAMURAI_ALERTS = savedAlerts;
    if (savedMode === undefined) delete process.env.SAMURAI_MODE;
    else process.env.SAMURAI_MODE = savedMode;
  });

  async function bootSaxo(
    gateway: SaxoOpenApiClient,
    logs?: LogEntry[],
    overrides: Partial<ProductionConfig> = {},
  ): Promise<ProductionOrchestrator> {
    process.env[BROKER_VENUE_ENV_VAR] = 'saxo';
    return await startFromEnvironment({
      ...startingProfileForMode('paper', undefined, 'saxo'),
      ...offlineInjections(db),
      ...(logs === undefined ? {} : { logger: { log: (entry: LogEntry) => logs.push(entry) } }),
      lseMarkClient: fixtureLseMarkClient(),
      saxoBrokerClient: gateway,
      ...overrides,
    });
  }

  it('constructs the SAXO adapter under SAMURAI_BROKER=saxo, not the Alpaca one', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(orchestrator.broker).toBeInstanceOf(SaxoBrokerAdapter);
    expect(orchestrator.broker).not.toBeInstanceOf(AlpacaBrokerAdapter);
  });

  it('gives that adapter the LSE ETP pool as its universe, not the Alpaca default', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(orchestrator.universe).toEqual(saxoTradeableUniverse());
    // Named, not just derived: #1220's ruling narrowed the pool's tradeable
    // set to these five, and a silent change to that list changes what a live
    // ramp would trade
    expect(orchestrator.universe.map((instrument) => instrument.asset)).toEqual([
      '3LUS',
      'LQQ3',
      'LCO3',
      '3KOR',
      '3KWE',
    ]);
  });

  it("routes a bracket to the venue in the LINE's quote unit, not the book's (#1302)", async () => {
    const gateway = fixtureSaxoGateway();
    const orchestrator = await bootSaxo(gateway);
    const instrument = orchestrator.universe[0]?.asset ?? '';

    await orchestrator.broker.submitBracket({
      client_order_id: 'k-1400',
      instrument,
      asset_class: 'stocks',
      side: 'buy',
      size: 10,
      entry: 31.15,
      stop: 29,
      target: 33,
      time_in_force: 'day',
    });

    expect(gateway.placed).toHaveLength(1);
    const order = gateway.placed[0];
    expect(order?.Uic).toBeGreaterThan(0);
    // The book prices in GBP; the line quotes in pence. Unscaled pence is not
    // reachable from here — 31.15 leaves as 3115, not as 31.15
    expect(order?.OrderPrice).toBeCloseTo(3115, 6);
    expect(order?.Orders?.map((leg) => leg.OrderPrice)).toEqual([2900, 3300]);
  });

  it('starts and stops the Saxo-wired orchestrator without a wiring refusal', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());
    started = orchestrator;

    // The tick loop's own startup path — orphan scan, bracket reload, scheduler
    // admission of the LSE universe — is where a miswired venue refuses. A tick
    // itself is not asserted: the mark and LLM sides here are fixtures
    await expect(orchestrator.start()).resolves.toBeDefined();
  });

  /**
   * #1400 AC3's sixth stage, which SIM could not show — and what Execution
   * does once it is reached.
   *
   * The real SIM run (doc 44 section 6.7) stopped one stage earlier, at
   * Verdict's `stale_feed` gate. That is a real gate, not a wiring refusal,
   * and no tick time clears it while the LSE real-time mark vendor is
   * unprovisioned (#895): 0 of 65 `infoprices` readings across a whole
   * morning came in under the 900 s bound. So SIM never reached Execution,
   * and never reached the line this case reaches.
   *
   * Driving the SHIPPED composition root with the mark age as a fixture input
   * gets there. Until #1510, Execution refused here: `computeIdempotencyKey`
   * returns a 64-character sha256 hex digest and `submitBracket` asserted the
   * whole `ExternalReference` fit Saxo's 50. #1510 (David, 2026-09-14, option
   * 1) fixed it without touching `computeIdempotencyKey`: the adapter derives
   * a `<=43`-char venue reference (`saxoExternalReference`) and translates it
   * back to the real `client_order_id` on every read path, so this case now
   * pins the opposite of what it pinned before — the bracket reaches the
   * gateway.
   */
  it('reaches the sixth stage and places the bracket, the 64-character idempotency key fitting the venue reference (#1510)', async () => {
    const clock = new SimulatedClock(NOW);
    const gateway = fixtureSaxoGateway();
    const profile = startingProfileForMode('paper', undefined, 'saxo');
    const orchestrator = await bootSaxo(gateway, undefined, {
      clock,
      llmClient: new ConstantResponseLlmClient(),
      lseMarkClient: trendingLseMarkClient(NOW),
      /**
       * The ONE tuning value this fixture moves, and the reason it has to.
       *
       * No MI vendor is configured offline, so two of the three equity
       * analysts read `NO DATA` and land neutral; the mediator and the
       * technical analyst carry the whole lean, and `computeConvictionScore`
       * puts the debate at exactly the shipped floor (0.55). The Trader's
       * conviction ramp is ZERO AT THE FLOOR by design (#625), so a debate
       * that only equals it sizes 0 shares and skips on `below_min_notional`
       * — a property of an offline desk, not of the Saxo venue. Lowering the
       * floor gives the ramp somewhere to start.
       *
       * It does not weaken what this case asserts: the floor decides WHETHER
       * a bracket is produced, never what the Execution stage does with one,
       * and nothing in `saxo-venue.ts` or the adapter reads it.
       */
      traderConfig: { ...profile.traderConfig, conviction_floor: 0.45 },
    });
    // `startFromEnvironment` arms the tick loop, and `afterEach` closes the
    // in-memory store under it. Nothing races today only because NOW sits
    // outside #706's entry window, so the scheduler plans zero instruments —
    // moving NOW without this would make the suite flaky rather than fail
    started = orchestrator;
    const instrument = orchestrator.universe[0]?.asset ?? '';
    const bar = floorToBar(NOW, DEBATE_BAR_TIMEFRAME_MS);

    const outcome = await orchestrator.tickRunner.runInstrument(
      { asset: instrument, asset_class: 'stocks' },
      {
        clock,
        trace_id: 'trace-1400-saxo',
        logger: { log: () => undefined },
        auditLog: orchestrator.persistence.auditLog,
        currentTickStore: orchestrator.persistence.currentTickStore,
        decision_bar: {
          id: `${bar.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`,
          open_time: bar,
          timeframe_ms: DEBATE_BAR_TIMEFRAME_MS,
        },
      },
    );

    expect(
      orchestrator.persistence.auditLog.getByTraceId('trace-1400-saxo').map((row) => row.stage),
    ).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(outcome.final_stage).toBe('execution');
    expect(outcome.verdict_status).toBe('go');

    // No refusal: the venue reference derived from the 64-character key fits
    // Saxo's 50-char field, so `submitBracket` reaches the gateway
    expect(outcome.execution_result?.status).not.toBe('error');

    // The load-bearing one: the bracket actually reached the venue. Read off
    // the SAXO gateway itself, because the control arm executes on a
    // `SimulatedBrokerAdapter` by design (control-arm-wiring.ts) — "an order
    // was placed" against the control arm would prove nothing about this one
    expect(gateway.placed).not.toHaveLength(0);
    const order = gateway.placed[0];
    expect(order?.ExternalReference?.length).toBeLessThanOrEqual(43);
  });

  /**
   * The LSE closes at 16:30 London and `flatten_before_close_ms` is 5 minutes,
   * so the flatten tail is 16:25-16:30 London. The US cash close is 21:00
   * London, so the US tail is 20:55-21:00. Either instant alone would pass
   * under one calendar and fail under the other; both together pin WHICH
   * calendar the Saxo run resolved without reaching into the scheduler's
   * private config.
   */
  const LSE_FLATTEN_TAIL = new Date('2026-09-09T15:27:00.000Z');
  const US_FLATTEN_TAIL = new Date('2026-09-09T19:57:00.000Z');

  /**
   * #1400 AC3's evidence requirement, and the reason it is a test rather than
   * a log-tidying preference: a run's `PriceToContractFactor` per line decides
   * whether an order goes out in pence or in pounds (#1302), and before this
   * line the resolved value survived nowhere an operator could read it after
   * the fact. The real SIM run this ticket records is only checkable against
   * the units it traded on because this entry exists.
   */
  it('records each line’s resolved quote unit at boot, so a 100x factor is auditable', async () => {
    const logs: LogEntry[] = [];
    await bootSaxo(fixtureSaxoGateway(), logs);

    const built = logs.find((entry) => entry.event === 'saxo_venue_built');
    expect(built).toBeDefined();
    expect(built?.payload).toMatchObject({ venue: 'saxo', mode: 'paper', environment: 'sim' });
    const lines = (built?.payload as { lines?: unknown[] } | undefined)?.lines;
    expect(lines).toHaveLength(saxoTradeableUniverse().length);
    expect(lines?.[0]).toMatchObject({
      asset: '3LUS',
      asset_type: 'Etn',
      currency: 'GBP',
      price_currency: 'GBX',
      price_to_contract_factor: 0.01,
    });
    for (const line of lines ?? []) {
      expect(typeof (line as { uic?: unknown }).uic).toBe('number');
      expect((line as { price_to_contract_factor?: unknown }).price_to_contract_factor).toBe(0.01);
    }
    // The gateway is selected by name, never by URL, and no credential is
    // reachable from a log line
    const rendered = JSON.stringify(built);
    expect(rendered).not.toContain('gateway.saxobank.com');
    expect(rendered.toLowerCase()).not.toContain('token');
  });

  it('gates and flattens the Saxo run on the LSE close, not the US close', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(
      orchestrator.scheduler.nextTick({ now: () => LSE_FLATTEN_TAIL }).instruments,
    ).not.toEqual([]);
    // 4.5 hours of overnight-style carry (#668) is what the US tail would buy
    // on a book that has been closed since 16:30
    expect(orchestrator.scheduler.nextTick({ now: () => US_FLATTEN_TAIL }).instruments).toEqual([]);
  });

  it('sizes the Saxo run against the GBP book, never the USD-converted ceiling', async () => {
    const profile = startingProfileForMode('paper', undefined, 'saxo');

    // The account is GBP-native, so the ceiling is the book itself. #1180's
    // conversion is not reversed — it applies to the Alpaca USD account, and
    // converting again against a GBP account would clamp £1,000 at £1,270
    expect(profile.capitalCeilingUsd).toBe(LIVE_BOOK_GBP);
    // `in`-narrowed rather than read directly: the live arm of this union has
    // no such field at all, and the assertion is that the Saxo arm announces
    // no conversion either
    expect(
      'capitalCeilingUsdPerGbp' in profile && profile.capitalCeilingUsdPerGbp !== undefined,
    ).toBe(false);
    // The Alpaca path keeps the converted ceiling, unchanged
    expect(startingProfileForMode('paper').capitalCeilingUsd).toBe(LIVE_BOOK_SIZING_USD);
  });

  // #1511 round-2 review: nothing outside risk-manager/ pinned the ONE line
  // (`paperStartingProfile`'s `bookCurrency === 'GBP'` branch) that actually
  // arms `RiskConfig.long_only_instruments` — the risk-manager suite drives
  // the hand-built `makeConfig()` fixture, which proves the gate logic but
  // not that the composition root ever wires the config the gate reads
  it('arms long_only_instruments with the Saxo tradeable set, and only on the Saxo path', () => {
    const saxoProfile = paperStartingProfile('paper', saxoTradeableUniverse(), 'GBP');

    expect(saxoProfile.riskConfig.long_only_instruments).toEqual(
      new Set(saxoTradeableUniverse().map((instrument) => instrument.asset)),
    );

    // The Alpaca path — every shipped run today — carries no such field, so
    // the #1511 gate stays inert there by construction, not by an instrument
    // list that happens to be empty
    expect(paperStartingProfile('paper').riskConfig.long_only_instruments).toBeUndefined();
  });

  /**
   * The verification is scoped by VENUE, not by who built the funding source
   * (#1509 round 2). Injecting the gateway is what makes this discriminating:
   * the entrypoint then builds no Saxo client and no funding source of its
   * own, so a check written against the one it builds — `saxoAccountFunding`
   * rather than `fundingToVerify` — computes no verdict here and this boot
   * succeeds on EUR.
   */
  it('refuses a Saxo boot whose INJECTED accountFunding answers a foreign currency', async () => {
    const eurFunding: AccountFundingSource = {
      readFunding: async () => ({ cash: 1_000, equity: 1_000, currency: 'EUR' }),
    };

    await expect(
      bootSaxo(fixtureSaxoGateway(), undefined, { accountFunding: eurFunding }),
    ).rejects.toThrow(/EUR/);
  });

  it('leaves the Alpaca paper path in place when the venue is not configured', async () => {
    delete process.env[BROKER_VENUE_ENV_VAR];

    const orchestrator = await startFromEnvironment({
      ...startingProfileForMode('paper'),
      ...offlineInjections(db),
      alpacaBrokerClient: {} as unknown as NonNullable<ProductionConfig['alpacaBrokerClient']>,
      alpacaDataClient: {} as unknown as NonNullable<ProductionConfig['alpacaDataClient']>,
    });

    expect(orchestrator.broker).toBeInstanceOf(AlpacaBrokerAdapter);
    // The universe the profile shipped before #1400, unredirected: this is
    // what goes red if the venue ever defaults to anything but Alpaca
    expect(orchestrator.universe).toEqual(paperStartingProfile('paper').universe);
    expect(orchestrator.universe).not.toEqual(saxoTradeableUniverse());
  });
});
