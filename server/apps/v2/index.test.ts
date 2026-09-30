import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrderSide,
  Sleeve,
  SleeveContext,
  SleeveSpec,
  Venue,
} from '../../../contracts/index.js';
import { writeKeepAliveState } from '../../pipeline/execution/adapters/saxo-keepalive-state.js';
import { writeTokenFile } from '../../pipeline/execution/adapters/saxo-token-file.js';
import type { AlpacaBrokerClient, AlpacaOrder } from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { CommandRunner } from './backup.js';
import { type BarRefresh, NO_BAR_REFRESH } from './bar-refresh.js';
import type { CycleReport } from './cycle.js';
import {
  BarsMarketData,
  CfdCatalogue,
  NO_NEWS,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import {
  composeV2Root,
  DEFAULT_HALF_SPREAD_BPS,
  exitCodeFor,
  halfSpreadLookup,
  llmKeysPresent,
  logNewRefusals,
  main,
  newsWiringFor,
  nousOptionsFrom,
  parseCliArgs,
  rootOptionsFor,
  runAfterPinCheck,
  type V2RootOptions,
  withoutRefusedLse,
} from './index.js';
import { CapitalConfigStore } from './risk/index.js';
import type { ModelPin } from './signal/index.js';
import { BULLISH_SCRIPT, isLseInstrument, ScriptedTransport } from './signal/index.js';
import { LSE_LIQUIDITY_SCREEN } from './signal/parameters.js';

const liveTokenFile = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('../../pipeline/execution/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pipeline/execution/index.js')>();
  return {
    ...actual,
    tokenFilePath: (environment: Parameters<typeof actual.tokenFilePath>[0]) =>
      environment === 'live' && liveTokenFile.path !== undefined
        ? liveTokenFile.path
        : actual.tokenFilePath(environment),
  };
});

interface Fixtures {
  directory: string;
  barStoreRoot: string;
  constituentsPath: string;
  fxPath: string;
  spreadsPath: string;
}

async function writeFixtures(
  saxoSymbols: readonly string[] = [],
  usSymbols: readonly string[] = [],
): Promise<Fixtures> {
  const directory = mkdtempSync(join(tmpdir(), 'v2-root-'));
  const bars: DailyBar[] = [];
  const origin = Date.UTC(2026, 0, 1);
  for (let i = 0; i <= 260; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    const date = new Date(origin + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  const barStoreRoot = join(directory, 'parquet');
  const store = await ParquetBarStore.open(barStoreRoot);
  await store.write('alpaca', [
    { symbol: 'UP', bars },
    { symbol: 'SPY', bars },
    ...usSymbols.map((symbol) => ({ symbol, bars })),
  ]);
  if (saxoSymbols.length > 0) {
    await store.write(
      'saxo',
      saxoSymbols.map((symbol) => ({ symbol, bars })),
    );
  }
  store.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(
    constituentsPath,
    `date,tickers\n2016-01-04,"${['UP', 'MISSING', ...usSymbols].join(',')}"\n`,
  );
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(
    spreadsPath,
    'symbol,sessions,median_half_spread_bps\n UP ,10,0\nBAD,1,abc\nNEG,1,-1\n',
  );
  return { directory, barStoreRoot, constituentsPath, fxPath, spreadsPath };
}

const LAST_CLOSE = 20 * (1 + 0.001 * 259);
const ENTRY_DATE = new Date(Date.UTC(2026, 0, 1) + 260 * 86_400_000).toISOString().slice(0, 10);
const NEXT_DATE = new Date(Date.UTC(2026, 0, 1) + 261 * 86_400_000).toISOString().slice(0, 10);

function seededStore(path = ':memory:'): StoreHandle {
  const db = openSharedStore(path);
  new CapitalConfigStore(db, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    1_000,
    1_500,
  );
  return db;
}

function count(root: { db: { prepare: (sql: string) => { get: () => unknown } } }, table: string) {
  return (root.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function scriptedFactory(transports: ScriptedTransport[]) {
  return (pin: ModelPin) => {
    const transport = new ScriptedTransport(pin, BULLISH_SCRIPT);
    transports.push(transport);
    return transport;
  };
}

function fakeAlpacaClient(clock: SimulatedClock): AlpacaBrokerClient & { orders: AlpacaOrder[] } {
  const orders: AlpacaOrder[] = [];
  const filled = (order: AlpacaOrder): AlpacaOrder => ({
    ...order,
    status: 'filled',
    filled_qty: order.qty,
    filled_avg_price: order.limit_price ?? '0',
    filled_at: clock.now().toISOString(),
  });
  return {
    orders,
    submitOrder: vi.fn((request) => {
      const order: AlpacaOrder = {
        id: `alp-${orders.length + 1}`,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'bracket',
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.limit_price,
        legs: [
          {
            id: `${orders.length + 1}-tp`,
            type: 'limit',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
          {
            id: `${orders.length + 1}-sl`,
            type: 'stop',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
        ],
      };
      orders.push(order);
      return Promise.resolve(order);
    }),
    getOrder: vi.fn((id: string) => {
      const order = orders.find((candidate) => candidate.id === id);
      return order === undefined
        ? Promise.reject(new Error(`no order ${id}`))
        : Promise.resolve(filled(order));
    }),
    getOrderByClientOrderId: vi.fn((clientOrderId: string) => {
      const order = orders.find((candidate) => candidate.client_order_id === clientOrderId);
      return Promise.resolve(order === undefined ? null : filled(order));
    }),
    submitMarketOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitOcoOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitLimitOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitStopLimitOrder: vi.fn().mockRejectedValue(new Error('unused')),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    listOpenOrders: vi.fn(() =>
      Promise.resolve(
        orders.map((order) => ({
          ...order,
          id: `${order.id}-sl`,
          client_order_id: `${order.client_order_id}-stop`,
          side: order.side === 'buy' ? ('sell' as const) : ('buy' as const),
          type: 'stop',
          order_class: 'simple',
          status: 'new',
        })),
      ),
    ),
    getPositions: vi.fn(() =>
      Promise.resolve(
        orders.map((order) => ({
          symbol: order.symbol,
          qty: order.qty,
          side: order.side === 'buy' ? ('long' as const) : ('short' as const),
          avg_entry_price: order.limit_price ?? '0',
        })),
      ),
    ),
    getAccount: vi.fn().mockResolvedValue({ cash: '100000', equity: '100000' }),
  };
}

describe('withoutRefusedLse', () => {
  const context = { tradingDate: '2026-09-29' } as SleeveContext;
  const refusals = [{ scope: 'universe', parameter: 'X', ticket: '#1', message: 'kept' }] as const;
  const fake = (): Sleeve => ({
    id: 'fake',
    spec: {} as SleeveSpec,
    universe: () => ({ instruments: ['UP', 'ISF', 'IUSA', 'SPY'], refusals }),
    decide: async () => ({ decisions: [], refusals: [] }),
  });

  it('returns the very same sleeve when the Saxo session is healthy', () => {
    const sleeve = fake();
    expect(withoutRefusedLse(sleeve, undefined)).toBe(sleeve);
  });

  it('drops every LSE line from the universe, and only those, when the session is refused', () => {
    const wrapped = withoutRefusedLse(fake(), 'session lost');
    expect(wrapped.universe(context).instruments).toEqual(['UP', 'SPY']);
    expect(wrapped.universe(context).refusals).toEqual(refusals);
  });

  it('keeps the sleeve identity and its decide behaviour', async () => {
    const wrapped = withoutRefusedLse(fake(), 'session lost');
    expect(wrapped.id).toBe('fake');
    await expect(wrapped.decide(context, ['UP'])).resolves.toEqual({
      decisions: [],
      refusals: [],
    });
  });
});

describe('rootOptionsFor', () => {
  let directory: string | undefined;
  const tokenDirectory = mkdtempSync(join(tmpdir(), 'v2-live-token-'));
  const tokenPath = join(tokenDirectory, 'live.json');
  const configuredScreen = LSE_LIQUIDITY_SCREEN.value;
  beforeEach(() => {
    Object.assign(LSE_LIQUIDITY_SCREEN, { value: 1 });
  });
  afterEach(() => {
    Object.assign(LSE_LIQUIDITY_SCREEN, { value: configuredScreen });
    liveTokenFile.path = undefined;
    rmSync(tokenPath, { force: true });
    rmSync(`${tokenPath}.keepalive.json`, { force: true });
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });
  afterAll(() => rmSync(tokenDirectory, { recursive: true, force: true }));

  const saxoSession = (clock: SimulatedClock, refreshTokenLifeMs: number) => ({
    environment: 'live' as const,
    accessToken: 'access-fixture',
    refreshToken: 'refresh-fixture',
    accessTokenExpiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(clock.now().getTime() + refreshTokenLifeMs).toISOString(),
    obtainedAt: new Date(clock.now().getTime() - 3_600_000).toISOString(),
  });

  async function composedFrom(clock: SimulatedClock) {
    const fixtures = await writeFixtures(
      ['ISF', 'IUSA'],
      Array.from({ length: 10 }, (_, i) => `US${i}`),
    );
    directory = fixtures.directory;
    liveTokenFile.path = tokenPath;
    const storePath = join(fixtures.directory, 'wired.sqlite');
    seededStore(storePath).close();
    return composeV2Root({
      ...fixtures,
      ...rootOptionsFor(true, ENTRY_DATE, {}, clock, { log: () => {} }),
      storePath,
    });
  }

  const universesOf = (root: ReturnType<typeof composeV2Root>) =>
    root.registry
      .list()
      .map(
        (sleeve) =>
          sleeve.universe({ tradingDate: ENTRY_DATE, macroDay: false, dryRun: true }).instruments,
      );
  const lseInstrumentsOf = (root: ReturnType<typeof composeV2Root>) =>
    universesOf(root)
      .flat()
      .filter((symbol) => isLseInstrument(symbol));

  it('reads the real live token file: an expired session journals SAXO_SESSION and hands every LSE slot to a US name (#1913)', async () => {
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    writeTokenFile(tokenPath, saxoSession(clock, -1));
    const root = await composedFrom(clock);
    try {
      await root.run();
      expect(root.journal.newRefusals(ENTRY_DATE)).toContainEqual(
        expect.objectContaining({
          parameter: 'SAXO_SESSION',
          ticket: '#1876',
          message: expect.stringContaining('the Saxo live refresh token expired'),
        }),
      );
      expect(lseInstrumentsOf(root)).toEqual([]);
      expect(universesOf(root).map((universe) => universe.length)).toEqual([10, 10, 0]);
    } finally {
      root.close();
    }
  });

  it('reads the keep-alive verdict beside the token file: a lost session refuses too', async () => {
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    writeTokenFile(tokenPath, saxoSession(clock, 1_800_000));
    writeKeepAliveState(tokenPath, {
      lostAt: clock.now().toISOString(),
      lostReason: 'refresh rejected',
    });
    const root = await composedFrom(clock);
    try {
      await root.run();
      expect(root.journal.newRefusals(ENTRY_DATE)).toContainEqual(
        expect.objectContaining({
          parameter: 'SAXO_SESSION',
          message: expect.stringContaining('refresh rejected'),
        }),
      );
      expect(lseInstrumentsOf(root)).toEqual([]);
    } finally {
      root.close();
    }
  });

  it('journals no refusal and keeps the LSE universe for a healthy session', async () => {
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    writeTokenFile(tokenPath, saxoSession(clock, 1_800_000));
    const root = await composedFrom(clock);
    try {
      await root.run();
      expect(
        root.journal.newRefusals(ENTRY_DATE).filter((r) => r.parameter === 'SAXO_SESSION'),
      ).toEqual([]);
      expect(lseInstrumentsOf(root).length).toBeGreaterThan(0);
      expect(universesOf(root).map((universe) => universe.length)).toEqual([10, 10, 0]);
    } finally {
      root.close();
    }
  });
});

describe('composeV2Root', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('logs an unreadable CFD catalogue and still composes with every CFD route closed', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const cfdCataloguePath = join(fixtures.directory, 'catalogue.json');
    writeFileSync(cfdCataloguePath, '{not json');
    const storePath = join(fixtures.directory, 'cfd.sqlite');
    seededStore(storePath).close();
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath,
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger: { log: (entry) => logs.push(entry) },
      cfdCataloguePath,
    });
    try {
      expect(logs.filter((entry) => entry.event === 'v2_cfd_catalogue_unreadable')).toHaveLength(1);
    } finally {
      root.close();
    }
  });

  it('composes without a catalogue file and without logging when none exists', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const storePath = join(fixtures.directory, 'nocfd.sqlite');
    seededStore(storePath).close();
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath,
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger: { log: (entry) => logs.push(entry) },
      cfdCataloguePath: join(fixtures.directory, 'absent.json'),
    });
    try {
      expect(logs.filter((entry) => entry.event === 'v2_cfd_catalogue_unreadable')).toEqual([]);
    } finally {
      root.close();
    }
  });

  function cfdEntry(instrument: string, venue: Venue, side: OrderSide) {
    return {
      instrument,
      venue,
      side,
      leg: 'entry' as const,
      qty: 1,
      priceGbp: 100,
      feeGbp: 0,
      clientOrderId: `cfd-${instrument}`,
      tradingDate: ENTRY_DATE,
      stopGbp: undefined,
      targetGbp: undefined,
    };
  }

  async function cfdCarryRoot(options: Partial<V2RootOptions>) {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'carry.sqlite');
    seededStore(storePath).close();
    return composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath,
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      cfdCataloguePath: join(fixtures.directory, 'absent.json'),
      ...options,
    });
  }

  it("carries CFDs on the declared Saxo models, a short's borrow read from the catalogue quote or the 2% ceiling", async () => {
    const quoted = { symbol: 'TSLA', saxoSymbol: 'TSLA:xnas', uic: 1, borrowCostPerDay: 0.0001 };
    const cfdCatalogue = new CfdCatalogue({
      asOf: ENTRY_DATE,
      instruments: [quoted, { ...quoted, symbol: 'NVDA', uic: 2, borrowCostPerDay: undefined }].map(
        (row) => ({
          ...row,
          assetType: 'CfdOnStock' as const,
          currency: 'USD' as const,
          priceToContractFactor: 1,
          tradable: true,
          shortTradeDisabled: false,
        }),
      ),
    });
    const root = await cfdCarryRoot({ cfdCatalogue });
    try {
      root.books.applyFill('debate/primary', cfdEntry('TSLA', 'saxo_cfd_usd', 'sell'));
      root.books.applyFill('debate/primary', cfdEntry('NVDA', 'saxo_cfd_usd', 'sell'));
      root.books.applyFill('debate/primary', cfdEntry('AMD', 'saxo_cfd_usd', 'sell'));
      root.books.applyFill('debate/primary', cfdEntry('AAPL', 'saxo_cfd_usd', 'buy'));
      const day = root.books.markDay('debate/primary', ENTRY_DATE, () => 100, 1);
      expect(day.cfdBorrowAccrualGbp).toBeCloseTo(100 * 0.0001 + (2 * 100 * 0.02) / 360, 12);
      expect(day.cfdFinancingAccrualGbp).toBeCloseTo((100 * 0.072) / 360, 12);
    } finally {
      root.close();
    }
  });

  it('carries CFDs on an injected cost model over the declared one, with no catalogue quote', async () => {
    const declined = () => {
      throw new Error('fill-leg model not used by the mark');
    };
    const root = await cfdCarryRoot({
      cfdCosts: {
        fee: { fee: declined },
        spread: { halfSpreadBps: declined },
        financing: { dailyRate: (_venue, side) => (side === 'long' ? 0.01 : 0.002) },
        borrow: { dailyRate: (_venue, quoted) => quoted ?? 0.03 },
      },
    });
    try {
      root.books.applyFill('debate/primary', cfdEntry('TSLA', 'saxo_cfd_usd', 'sell'));
      const day = root.books.markDay('debate/primary', ENTRY_DATE, () => 100, 2);
      expect(day.cfdFinancingAccrualGbp).toBeCloseTo(100 * 0.002 * 2, 12);
      expect(day.cfdBorrowAccrualGbp).toBeCloseTo(100 * 0.03 * 2, 12);
    } finally {
      root.close();
    }
  });

  it('dry run: sizes, reaches the dry-run broker, submits nothing, journals every LLM call and fill', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const logger: Logger = { log: (entry) => logs.push(entry) };
    const storePath = join(fixtures.directory, 'dry.sqlite');
    seededStore(storePath).close();
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const open = (tradingDate: string) =>
      composeV2Root({ ...fixtures, tradingDate, dryRun: true, storePath, clock, logger });
    const root = open(ENTRY_DATE);
    try {
      expect(root.registry.ids()).toEqual(['debate', 'arm2', 'signals']);
      expect(root.books.ids()).toEqual([
        'debate/primary',
        'debate/no-macro-gate',
        'arm2/technical-only',
        'signals/primary',
        'signals/no-veto',
      ]);
      const report = await root.run();
      expect(report).toMatchObject({
        decisions: 2,
        entries: 3,
        submitted_orders: 0,
        dry_run_refusals: 1,
        simulated_orders: 2,
        rejected_orders: 0,
        fills: 0,
        sleeves: ['debate', 'arm2', 'signals'],
      });
      expect(exitCodeFor(report)).toBe(0);
      const needsDavid = report.refusals.filter((refusal) => refusal.includes('needs David'));
      expect(needsDavid).toHaveLength(6);
      expect(needsDavid.some((refusal) => refusal.includes('CFD_RESTING_STOP_VERIFIED'))).toBe(
        true,
      );
      for (const parameter of [
        'CFD_COST_MODEL',
        'CFD_SPREAD_MODEL',
        'CFD_FINANCING_MODEL',
        'CFD_BORROW_MODEL',
      ]) {
        expect(needsDavid.some((refusal) => refusal.includes(parameter))).toBe(false);
      }
      const decision = root.db
        .prepare('SELECT action, size_shares, stop_price FROM v2_decisions WHERE book_id = ?')
        .get('debate/primary') as { action: string; size_shares: number; stop_price: number };
      expect(decision.action).toBe('enter_long');
      expect(decision.size_shares).toBeGreaterThan(0);
      expect(decision.stop_price).toBeGreaterThan(0);
      expect(root.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'refused_dry_run',
        dry_run: true,
        payload: {
          size: decision.size_shares,
          approval: `entry:v2-debate-primary-${ENTRY_DATE}-UP:${decision.size_shares}`,
        },
      });
      expect(root.journal.orderFor(`v2-debate-no-macro-gate-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'simulated',
        payload: { approval: expect.stringMatching(/^entry:v2-debate-no-macro-gate-/) },
      });
      expect(root.journal.orderFor(`v2-arm2-technical-only-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'simulated',
        payload: { approval: expect.stringMatching(/^entry:v2-arm2-technical-only-/) },
      });
      expect(count(root, 'v2_orders')).toBe(3);
      expect(count(root, 'v2_fills')).toBe(0);
      expect(report.books.map((book) => book.positions)).toEqual([0, 0, 0, 0, 0]);
      const llmCalls = root.scriptedTransports.reduce((n, t) => n + t.calls.length, 0);
      expect(llmCalls).toBe(3);
      expect(count(root, 'llm_spend')).toBe(llmCalls);
      expect(count(root, 'llm_call_log')).toBe(llmCalls);
      expect(logs.some((entry) => entry.event === 'v2_llm_transport_scripted')).toBe(true);
      for (const transport of root.scriptedTransports) {
        for (const call of transport.calls) {
          expect(call.prompt).not.toMatch(/api[_-]?key|ALPACA|SAXO|account/i);
        }
      }
    } finally {
      root.close();
    }
    clock.advanceTo(new Date(`${NEXT_DATE}T07:00:00.000Z`));
    const next = open(NEXT_DATE);
    try {
      const report = await next.run();
      expect(report).toMatchObject({ fills: 3, entries: 0 });
      const size = next.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)?.payload.size;
      expect(next.books.position('debate/primary', 'UP')?.qty).toBe(size);
      const fx = new BarsMarketData(
        new ParquetBarsSource(fixtures.barStoreRoot, 'alpaca'),
        parseBoeGbpUsdCsv(readFileSync(fixtures.fxPath, 'utf8')),
      ).gbpUsdAtYearStart(2026);
      const fill = next.db
        .prepare('SELECT price_gbp, fee_gbp, trading_date FROM v2_fills WHERE book_id = ?')
        .get('debate/no-macro-gate') as {
        price_gbp: number;
        fee_gbp: number;
        trading_date: string;
      };
      expect(fill.price_gbp * fx).toBeCloseTo(LAST_CLOSE, 6);
      expect(fill.fee_gbp).toBeGreaterThan(0);
      expect(fill.trading_date).toBe(NEXT_DATE);
      expect(report.books.map((book) => book.positions)).toEqual([1, 1, 1, 0, 0]);
    } finally {
      next.close();
    }
  });

  it('journals one SAXO_SESSION refusal against #1876 when the LSE leg is refused, and none otherwise', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const open = (lseLegRefusal: string | undefined, storePath: string) => {
      seededStore(storePath).close();
      return composeV2Root({
        ...fixtures,
        tradingDate: ENTRY_DATE,
        dryRun: true,
        storePath,
        clock,
        logger: { log: () => {} },
        lseLegRefusal,
      });
    };
    const refused = open(
      'the Saxo live session was lost: run `npm run saxo:login`',
      join(fixtures.directory, 'a.sqlite'),
    );
    try {
      await refused.run();
      expect(refused.journal.newRefusals(ENTRY_DATE)).toContainEqual(
        expect.objectContaining({
          scope: 'data',
          parameter: 'SAXO_SESSION',
          ticket: '#1876',
          message: expect.stringContaining('npm run saxo:login'),
        }),
      );
    } finally {
      refused.close();
    }
    const healthy = open(undefined, join(fixtures.directory, 'b.sqlite'));
    try {
      await healthy.run();
      expect(
        healthy.journal.newRefusals(ENTRY_DATE).filter((r) => r.parameter === 'SAXO_SESSION'),
      ).toEqual([]);
    } finally {
      healthy.close();
    }
  });

  it('paper mode: the primary reaches AlpacaBrokerAdapter.submitBracket, the fill is ingested, and the bracket survives a restart', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'paper.sqlite');
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const alpacaClient = fakeAlpacaClient(clock);
    const transports: ScriptedTransport[] = [];
    seededStore(storePath).close();
    const open = (tradingDate: string, newsCalls: string[]) =>
      composeV2Root({
        ...fixtures,
        tradingDate,
        dryRun: false,
        storePath,
        nousBaseUrl: 'https://nous.test/v1',
        nousApiKey: 'present',
        clock,
        logger: { log: () => {} },
        transportFor: scriptedFactory(transports),
        alpacaClient,
        newsSource: {
          headlines: (symbol) => {
            newsCalls.push(symbol);
            return Promise.resolve(['UP beats on revenue']);
          },
        },
      });
    const newsCalls: string[] = [];
    const first = open(ENTRY_DATE, newsCalls);
    let report: CycleReport;
    try {
      report = await first.run();
      expect(report).toMatchObject({
        dry_run: false,
        entries: 3,
        submitted_orders: 1,
        simulated_orders: 2,
        dry_run_refusals: 0,
        fills: 1,
      });
      expect(exitCodeFor(report)).toBe(0);
      expect(newsCalls).toEqual(['UP']);
      expect(alpacaClient.submitOrder).toHaveBeenCalledTimes(1);
      expect(alpacaClient.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          client_order_id: `v2-debate-primary-${ENTRY_DATE}-UP`,
          symbol: 'UP',
          side: 'buy',
          order_class: 'bracket',
          time_in_force: 'gtc',
        }),
      );
      const qty = Number(alpacaClient.orders[0]?.qty);
      expect(qty).toBeGreaterThan(0);
      expect(first.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'submitted',
        dry_run: false,
        payload: { approval: `entry:v2-debate-primary-${ENTRY_DATE}-UP:${qty}` },
      });
      expect(first.books.position('debate/primary', 'UP')?.qty).toBe(qty);
      expect(first.books.position('debate/no-macro-gate', 'UP')).toBeUndefined();
      expect(count(first, 'v2_fills')).toBe(1);
      expect(count(first, 'broker_brackets')).toBe(1);
      expect(
        transports
          .flatMap((t) => t.calls)
          .some((call) => call.prompt.includes('UP beats on revenue')),
      ).toBe(true);
    } finally {
      first.close();
    }
    clock.advanceTo(new Date(`${NEXT_DATE}T07:00:00.000Z`));
    const second = open(NEXT_DATE, newsCalls);
    try {
      const next = await second.run();
      expect(next).toMatchObject({ skipped: false, submitted_orders: 0, entries: 0 });
      expect(alpacaClient.getOrder).toHaveBeenCalled();
      expect(alpacaClient.submitOrder).toHaveBeenCalledTimes(1);
      expect(second.books.position('debate/primary', 'UP')?.marksHeld).toBe(2);
      expect(second.books.position('debate/no-macro-gate', 'UP')).toMatchObject({
        qty: Number(alpacaClient.orders[0]?.qty),
        marksHeld: 1,
      });
      expect(second.books.position('arm2/technical-only', 'UP')).toMatchObject({
        marksHeld: 1,
      });
      expect(
        second.db
          .prepare("SELECT status FROM v2_reconciles WHERE trading_date = ? AND source = 'broker'")
          .all(NEXT_DATE),
      ).toEqual([{ status: 'clean' }]);
    } finally {
      second.close();
    }
  });

  it('paper mode never compares cash: the unset cash tolerance refuses no entry, and the run says cash was not compared', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'paper.sqlite');
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const alpacaClient = fakeAlpacaClient(clock);
    seededStore(storePath).close();
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath,
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'present',
      clock,
      logger: { log: () => {} },
      transportFor: scriptedFactory([]),
      alpacaClient,
      newsSource: { headlines: () => Promise.resolve(['UP beats on revenue']) },
    });
    try {
      const report = await root.run();
      expect(report).toMatchObject({ submitted_orders: 1, simulated_orders: 2 });
      expect(alpacaClient.submitOrder).toHaveBeenCalledTimes(1);
      expect(
        root.db
          .prepare(
            "SELECT parameter FROM v2_refusals WHERE parameter = 'RECONCILE_CASH_TOLERANCE_GBP' OR scope = 'reconcile'",
          )
          .all(),
      ).toEqual([]);
      expect(
        root.db.prepare("SELECT status, detail FROM v2_reconciles WHERE source = 'broker'").all(),
      ).toEqual([
        { status: 'clean', detail: 'cash not compared on paper (David 2026-09-29, #1872)' },
      ]);
    } finally {
      root.close();
    }
  });

  it('routes a UK stock to Marketaux through the real news wiring, journals the coverage and keeps the key out of every log', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const storePath = join(fixtures.directory, 'uk-news.sqlite');
    seededStore(storePath).close();
    const urls: string[] = [];
    const publishedAt = new Date(clock.now().getTime() - 20 * 3_600_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        urls.push(String(url));
        const article = { title: 'UP beats on revenue', published_at: publishedAt, entities: [{}] };
        const body = { meta: { found: 1, returned: 1, limit: 3, page: 1 }, data: [article] };
        return Promise.resolve(new Response(JSON.stringify(body)));
      }),
    );
    vi.stubEnv('ALPACA_API_KEY', 'key');
    vi.stubEnv('ALPACA_API_SECRET', 'secret');
    const logs: LogEntry[] = [];
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath,
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'present',
      clock,
      logger: { log: (entry) => logs.push(entry) },
      transportFor: scriptedFactory([]),
      alpacaClient: fakeAlpacaClient(clock),
      marketauxApiKey: 'mx-secret-key',
      isUkStock: (symbol) => symbol === 'UP',
    });
    try {
      await root.run();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('symbols=UP.L');
      expect(root.db.prepare('SELECT symbol, status, requested FROM v2_news').all()).toEqual([
        { symbol: 'UP', status: 'ok', requested: 1 },
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'v2_uk_news_coverage',
          message: 'UK news: 1 of 1 names had headlines, 0 NO_NEWS',
        }),
      );
      expect(JSON.stringify(logs)).not.toContain('mx-secret-key');
      const decision = root.db
        .prepare(
          "SELECT payload FROM v2_decisions WHERE instrument = 'UP' AND payload LIKE '%headlines%'",
        )
        .get() as { payload: string };
      expect(JSON.parse(decision.payload)).toMatchObject({ headlines: 1 });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      root.close();
    }
  });

  it('refuses entries but still runs without a capital config in force', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath: ':memory:',
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger: { log: () => {} },
    });
    try {
      expect(root.books.ids()).toEqual([]);
      const report = await root.run();
      expect(report).toMatchObject({ entries: 0, submitted_orders: 0, simulated_orders: 0 });
      expect(report.refusals.some((refusal) => refusal.includes('no capital config'))).toBe(true);
      expect(
        root.db.prepare("SELECT parameter FROM v2_refusals WHERE scope = 'capital'").get(),
      ).toEqual({ parameter: 'CAPITAL_CONFIG' });
      expect(count(root, 'v2_orders')).toBe(0);
    } finally {
      root.close();
    }
  });

  it('caps LLM calls at one in flight for the whole Nous account on the real transport factory', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const urls = new Set<string>();
    const authorizations = new Set<string>();
    const models: string[] = [];
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.add(url);
        authorizations.add((init.headers as Record<string, string>).authorization);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        models.push(model);
        const body = {
          model,
          choices: [
            { message: { content: '{"stance":"bullish","rationale":"x"}' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath: ':memory:',
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'nous-secret-key',
      alpacaClient: fakeAlpacaClient(new SimulatedClock(new Date())),
      newsSource: NO_NEWS,
      logger: { log: () => {} },
    });
    try {
      const request = {
        prompt: 'hello',
        context: { analyst_views: [] },
        parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
      };
      await Promise.all([
        root.panel.debaters.sonnet.complete(request),
        root.panel.judge.complete(request),
        root.panel.debaters.gpt.complete(request),
        root.panel.debaters.deepseek.complete(request),
      ]);
      expect(peak).toBe(1);
      expect([...urls]).toEqual(['https://nous.test/v1/chat/completions']);
      expect([...authorizations]).toEqual(['Bearer nous-secret-key']);
      expect(models.sort()).toEqual([
        'anthropic/claude-opus-5.5',
        'anthropic/claude-sonnet-5',
        'deepseek/deepseek-v4-pro-0813',
        'openai/gpt-5.5',
      ]);
      expect(count(root, 'llm_spend')).toBe(4);
    } finally {
      vi.unstubAllGlobals();
      root.close();
    }
  });

  it('logs each upstream model to stderr when the root is composed without a logger', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model,
              choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath: ':memory:',
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'present',
      alpacaClient: fakeAlpacaClient(new SimulatedClock(new Date())),
      newsSource: NO_NEWS,
    });
    try {
      await root.panel.judge.complete({
        prompt: 'hello',
        context: { analyst_views: [] },
        parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
      });
      const lines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('v2_llm_upstream_model'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        event: 'v2_llm_upstream_model',
        payload: { pinned: 'anthropic/claude-opus-5.5', upstream: 'anthropic/claude-opus-5.5' },
      });
    } finally {
      vi.unstubAllGlobals();
      stderr.mockRestore();
      root.close();
    }
  });

  it('refuses a paper run without LLM keys before opening the store', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'never.sqlite');
    expect(() =>
      composeV2Root({ ...fixtures, tradingDate: '2026-09-25', dryRun: false, storePath }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        nousBaseUrl: '',
        nousApiKey: 'x',
      }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        nousBaseUrl: 'https://nous.test/v1',
        nousApiKey: '',
      }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(existsSync(storePath)).toBe(false);
  });

  it('refuses live mode', () => {
    expect(() =>
      composeV2Root({
        tradingDate: '2026-09-25',
        dryRun: true,
        samuraiMode: 'live',
        storePath: ':memory:',
      }),
    ).toThrow(/refuses SAMURAI_MODE=live/);
  });

  it('parses the CLI, detects LLM keys, and fails a dry run that submitted', () => {
    expect(parseCliArgs(['--dry-run', '--date', '2026-09-23'], '2026-09-25')).toEqual({
      dryRun: true,
      tradingDate: '2026-09-23',
    });
    expect(parseCliArgs([], '2026-09-25')).toEqual({ dryRun: false, tradingDate: '2026-09-25' });
    expect(() => parseCliArgs(['--date'], '2026-09-25')).toThrow(/--date needs/);
    expect(() => parseCliArgs(['--bogus'], '2026-09-25')).toThrow(/unknown argument/);
    expect(llmKeysPresent({ tradingDate: 'd', dryRun: true })).toBe(false);
    expect(
      llmKeysPresent({ tradingDate: 'd', dryRun: true, nousBaseUrl: 'a', nousApiKey: ' ' }),
    ).toBe(false);
    expect(
      llmKeysPresent({ tradingDate: 'd', dryRun: true, nousBaseUrl: ' ', nousApiKey: 'b' }),
    ).toBe(false);
    expect(
      llmKeysPresent({
        tradingDate: 'd',
        dryRun: true,
        nousBaseUrl: 'a',
        nousApiKey: 'b',
      }),
    ).toBe(true);
    const base = { submitted_orders: 0, dry_run: true } as CycleReport;
    expect(exitCodeFor(base)).toBe(0);
    expect(exitCodeFor({ ...base, submitted_orders: 1 })).toBe(1);
    expect(exitCodeFor({ ...base, submitted_orders: 1, dry_run: false })).toBe(0);
  });
});

describe('halfSpreadLookup', () => {
  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('merges alpaca (positional) and saxo (p25_half_spread_bps column) spreads, defaulting the rest', () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-spreads-'));
    const alpacaPath = join(directory, 'alpaca-spreads.csv');
    writeFileSync(alpacaPath, 'symbol,sessions,median_half_spread_bps\nAAPL,10,3\nBAD,1,abc\n');
    const saxoPath = join(directory, 'saxo-spreads.csv');
    writeFileSync(
      saxoPath,
      'symbol,uic,samples,p25_half_spread_bps,median_half_spread_bps,measured_at\nISF,4361,10,4,5,2026-09-23\nNEG,1,1,-1,-1,x\n',
    );
    const lookup = halfSpreadLookup(alpacaPath, saxoPath);
    expect(lookup('AAPL')).toBe(3);
    expect(lookup('ISF')).toBe(4);
    expect(lookup('BAD')).toBe(DEFAULT_HALF_SPREAD_BPS);
    expect(lookup('NEG')).toBe(DEFAULT_HALF_SPREAD_BPS);
    expect(lookup('UNKNOWN')).toBe(DEFAULT_HALF_SPREAD_BPS);
  });

  it('defaults every saxo instrument when the file is missing or lacks the p25 column', () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-spreads-'));
    const alpacaPath = join(directory, 'alpaca-spreads.csv');
    writeFileSync(alpacaPath, 'symbol,sessions,median_half_spread_bps\nAAPL,10,3\n');
    const missingPath = join(directory, 'absent.csv');
    expect(existsSync(missingPath)).toBe(false);
    expect(halfSpreadLookup(alpacaPath, missingPath)('ISF')).toBe(DEFAULT_HALF_SPREAD_BPS);
    const noColumnPath = join(directory, 'no-column.csv');
    writeFileSync(noColumnPath, 'symbol,uic\nISF,4361\n');
    expect(halfSpreadLookup(alpacaPath, noColumnPath)('ISF')).toBe(DEFAULT_HALF_SPREAD_BPS);
  });
});

describe('nousOptionsFrom', () => {
  it('reads the Nous env exactly as v1 does: trimmed, NOUS_DEBATE_API_KEY first, NOUS_API_KEY as fallback', () => {
    expect(nousOptionsFrom({})).toEqual({ nousBaseUrl: undefined, nousApiKey: undefined });
    expect(
      nousOptionsFrom({ NOUS_BASE_URL: 'https://nous.test/v1', NOUS_DEBATE_API_KEY: '  ' }),
    ).toEqual({
      nousBaseUrl: undefined,
      nousApiKey: undefined,
    });
    expect(nousOptionsFrom({ NOUS_BASE_URL: '  ', NOUS_DEBATE_API_KEY: 'k' })).toEqual({
      nousBaseUrl: undefined,
      nousApiKey: undefined,
    });
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: ' https://nous.test/v1 ',
        NOUS_DEBATE_API_KEY: ' debate-key ',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
    expect(
      nousOptionsFrom({ NOUS_BASE_URL: 'https://nous.test/v1', NOUS_API_KEY: 'shared' }),
    ).toEqual({
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'shared',
    });
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: 'https://nous.test/v1',
        NOUS_DEBATE_API_KEY: 'debate-key',
        NOUS_API_KEY: 'shared',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
  });

  it("ignores v1's model knobs: an unpriced NOUS_DEBATE_MODEL does not stop a v2 run", () => {
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: 'https://nous.test/v1',
        NOUS_DEBATE_API_KEY: 'debate-key',
        NOUS_DEBATE_MODEL: 'vendor/unpriced-model',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
  });
});

describe('runAfterPinCheck', () => {
  it('runs no cycle when the pin check refuses', async () => {
    const run = vi.fn();
    await expect(
      runAfterPinCheck({ run }, () => Promise.reject(new Error('snapshot swapped'))),
    ).rejects.toThrow('snapshot swapped');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the cycle only after the pin check settles', async () => {
    const order: string[] = [];
    const report = { dry_run: false } as CycleReport;
    const result = await runAfterPinCheck(
      {
        run: () => {
          order.push('run');
          return Promise.resolve(report);
        },
      },
      async () => {
        await Promise.resolve();
        order.push('pins');
      },
    );
    expect(order).toEqual(['pins', 'run']);
    expect(result).toBe(report);
  });
});

describe('logNewRefusals', () => {
  it('warns once with the new refusals, and stays silent without any', () => {
    const entries: LogEntry[] = [];
    const logger = { log: (entry: LogEntry) => entries.push(entry) };
    const refusal = (parameter: string, message: string) => ({
      trading_date: '2026-09-28',
      scope: 'data',
      parameter,
      ticket: '#1',
      message,
    });
    const days: Record<string, ReturnType<typeof refusal>[]> = {
      '2026-09-28': [refusal('A', 'a'), refusal('B', 'b')],
    };
    const journal = { newRefusals: (date: string) => days[date] ?? [] };
    logNewRefusals(journal, '2026-09-28', logger);
    logNewRefusals(journal, '2026-09-29', logger);
    expect(entries).toEqual([
      {
        trace_id: 'v2-2026-09-28',
        stage: 'v2',
        level: 'warn',
        event: 'v2_new_refusals',
        message: 'A: a\nB: b',
      },
    ]);
  });
});

describe('main', () => {
  const R2 = {
    R2_ACCESS_KEY_ID: 'a',
    R2_SECRET_ACCESS_KEY: 'b',
    R2_ENDPOINT: 'https://c.example',
    R2_BUCKET: 'd',
    LITESTREAM_SSE_C_KEY: 'e',
  };

  async function mainQuietly(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    run?: CommandRunner,
    barRefresh?: BarRefresh,
  ) {
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      return await main(argv, env, run, undefined, barRefresh);
    } finally {
      written.mockRestore();
    }
  }

  it('reports a bad argument before asking for backup variables', async () => {
    await expect(mainQuietly(['--bogus'], {})).rejects.toThrow('unknown argument --bogus');
  });

  it('refuses a paper run without its backup variables', async () => {
    await expect(mainQuietly(['--date', '2026-09-28'], {})).rejects.toThrow(
      /paper run refuses without its Litestream backup/,
    );
  });

  it('restores missing stores before the cycle and still backs up when the cycle fails', async () => {
    const commands: string[] = [];
    const run: CommandRunner = (_bin, args) => {
      commands.push(args[0] ?? '');
      return Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    };
    const calls: string[] = [];
    const barRefresh: BarRefresh = {
      run: () => {
        calls.push('refreshed');
        return Promise.resolve({ attempted: 0, updated: [], noNewBars: [], failed: [] });
      },
    };
    const research = join(mkdtempSync(join(tmpdir(), 'main-backup-')), 'research.sqlite');
    await expect(
      mainQuietly(
        ['--date', '2026-09-28'],
        { ...R2, SAMURAI_RESEARCH_STORE: research },
        run,
        barRefresh,
      ),
    ).rejects.toThrow(/without NOUS_BASE_URL and a Nous key/);
    expect(commands).toEqual(['version', 'restore', 'restore']);
    expect(calls).toEqual(['refreshed']);
  });

  it('restores the stores before refusing a paper run without Alpaca keys', async () => {
    const commands: string[] = [];
    const run: CommandRunner = (_bin, args) => {
      commands.push(args[0] ?? '');
      return Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    };
    const research = join(mkdtempSync(join(tmpdir(), 'main-backup-')), 'research.sqlite');
    await expect(
      mainQuietly(['--date', '2026-09-28'], { ...R2, SAMURAI_RESEARCH_STORE: research }, run),
    ).rejects.toThrow(/ALPACA_API_KEY and ALPACA_API_SECRET must be set/);
    expect(commands).toEqual(['version', 'restore', 'restore']);
  });

  it('sends a failed cycle to Telegram as critical and its warnings silently', async () => {
    const run: CommandRunner = (_bin, args) =>
      Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    const research = join(mkdtempSync(join(tmpdir(), 'main-alerts-')), 'research.sqlite');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const env = {
      ...R2,
      SAMURAI_RESEARCH_STORE: research,
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: 'chat',
    };
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        main(['--date', '2026-09-28'], env, run, fetchImpl, NO_BAR_REFRESH),
      ).rejects.toThrow(/without NOUS_BASE_URL/);
    } finally {
      written.mockRestore();
    }
    const sent = fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
    expect(sent.map(([url]) => url)).toEqual([
      'https://api.telegram.org/botbot-token/sendMessage',
      'https://api.telegram.org/botbot-token/sendMessage',
    ]);
    const [critical, warning] = sent.map(([, body]) => body);
    expect(critical.disable_notification).toBe(false);
    expect(critical.text).toMatch(
      /^Samurai v2 CRITICAL\nv2_cycle_failed: v2 root refuses a paper run without NOUS_BASE_URL/,
    );
    expect(warning).toMatchObject({ chat_id: 'chat', disable_notification: true });
    expect(warning.text).toContain('v2_heartbeat_unset: HEALTHCHECKS_PING_URL is not set');
  });
});

describe('newsWiringFor', () => {
  const NOW = new Date('2026-09-29T07:00:00.000Z');
  const options = {
    tradingDate: '2026-09-29',
    dryRun: false,
    isUkStock: (symbol: string) => symbol === 'VOD',
    marketauxApiKey: '',
  };
  const quiet: Logger = { log: () => {} };
  beforeEach(() => {
    vi.stubEnv('ALPACA_API_KEY', 'key');
    vi.stubEnv('ALPACA_API_SECRET', 'secret');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const rows = (db: StoreHandle) => db.prepare('SELECT symbol, status, reason FROM v2_news').all();

  it('journals no_key for a UK stock when MARKETAUX_API_KEY is empty, and leaves ETFs and dry runs alone', async () => {
    const db = openSharedStore(':memory:');
    const { news, ukNews } = newsWiringFor(options, db, quiet);
    expect(ukNews).toBeDefined();
    expect(await news.headlines('ISF', '2026-09-29', NOW)).toEqual([]);
    expect(rows(db)).toEqual([]);
    expect(await news.headlines('VOD', '2026-09-29', NOW)).toEqual([]);
    expect(rows(db)).toEqual([{ symbol: 'VOD', status: 'no_key', reason: 'no_api_key' }]);

    const dryDb = openSharedStore(':memory:');
    const dry = newsWiringFor({ ...options, dryRun: true, marketauxApiKey: 'k' }, dryDb, quiet);
    expect(dry.ukNews).toBeUndefined();
    expect(await dry.news.headlines('VOD', '2026-09-29', NOW)).toEqual([]);
    expect(rows(dryDb)).toEqual([]);
  });

  it('treats an unset key like an empty one', async () => {
    const db = openSharedStore(':memory:');
    const { news } = newsWiringFor({ ...options, marketauxApiKey: undefined }, db, quiet);
    await news.headlines('VOD', '2026-09-29', NOW);
    expect(rows(db)).toEqual([{ symbol: 'VOD', status: 'no_key', reason: 'no_api_key' }]);
  });

  it('sends every non-ETF name to the US source until a pool supplies UK stocks', async () => {
    const db = openSharedStore(':memory:');
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        urls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ news: [], next_page_token: null })));
      }),
    );
    const { news } = newsWiringFor({ ...options, isUkStock: undefined }, db, quiet);
    expect(await news.headlines('VOD', '2026-09-29', NOW)).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('alpaca.markets');
    expect(rows(db)).toEqual([]);
  });

  it('uses an injected news source untouched', async () => {
    const db = openSharedStore(':memory:');
    const injected = { headlines: () => Promise.resolve(['injected']) };
    const { news, ukNews } = newsWiringFor({ ...options, newsSource: injected }, db, quiet);
    expect(news).toBe(injected);
    expect(ukNews).toBeUndefined();
  });

  it('reads the key from MARKETAUX_API_KEY', () => {
    const clock = new SimulatedClock(NOW);
    expect(
      rootOptionsFor(false, '2026-09-29', { MARKETAUX_API_KEY: 'from-env' }, clock, quiet),
    ).toMatchObject({
      marketauxApiKey: 'from-env',
    });
    expect(rootOptionsFor(false, '2026-09-29', {}, clock, quiet).marketauxApiKey).toBeUndefined();
  });
});
