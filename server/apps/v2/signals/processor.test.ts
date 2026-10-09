import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LatestQuote, LatestQuoteSource } from '../../../../contracts/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import type {
  AnthropicMessageRequest,
  AnthropicMessagesClient,
} from '../../../shared/debate/index.js';
import type { DailyBar } from '../../../shared/index.js';
import { type LogEntry, SimulatedClock } from '../../../shared/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { JournalReader } from '../api/journal-reader.js';
import type { AlpacaBrokerClient, AlpacaOrder } from '../execution/alpaca/alpaca-client.js';
import { composeV2Root, type V2Root, type V2RootOptions } from '../index.js';
import { sleeveCapitalYear } from '../risk/allocation.js';
import { CapitalConfigStore, dailyCapGbp } from '../risk/index.js';
import { RunLease } from '../run-lease.js';
import { type ModelPin, ScriptedTransport, SIGNALS_SLEEVE_SPEC } from '../signal/index.js';
import { parseSignalPayload } from './payload.js';
import { SignalStore } from './store.js';
import { SIGNAL_VETO_PROMPT } from './veto.js';
import { classifySignalWindow } from './window.js';

type Script = (request: AnthropicMessageRequest) => string;

const D = '2026-09-30';
const IN_SESSION = new Date(`${D}T14:00:00.000Z`);
const CALENDAR = new UsEquityRegularHoursCalendar();

interface Fixtures {
  readonly directory: string;
  readonly storePath: string;
  readonly base: Pick<
    V2RootOptions,
    'barStoreRoot' | 'constituentsPath' | 'fxPath' | 'spreadsPath' | 'saxoSpreadsPath'
  >;
}

const dirs: string[] = [];
const handles: StoreHandle[] = [];
const roots: V2Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function flatBars(overrides: Readonly<Record<string, Partial<DailyBar>>> = {}): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let time = Date.UTC(2026, 0, 1); time <= Date.UTC(2026, 9, 2); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    bars.push({
      date,
      open: 25,
      high: 25.25,
      low: 24.75,
      close: 25,
      volume: 3_000_000,
      rawClose: 25,
      ...overrides[date],
    });
  }
  return bars;
}

const UP_BARS = flatBars({
  [D]: { open: 25.1, high: 25.2, low: 24.9, close: 25, rawClose: 25 },
  '2026-10-01': { open: 25.2, high: 26.1, low: 25.1, close: 26, rawClose: 26 },
});

async function writeFixtures(capital: boolean = true): Promise<Fixtures> {
  const directory = mkdtempSync(join(tmpdir(), 'v2-signals-proc-'));
  dirs.push(directory);
  const barStoreRoot = join(directory, 'parquet');
  const bars = await ParquetBarStore.open(barStoreRoot);
  await bars.write('alpaca', [
    { symbol: 'UP', bars: UP_BARS },
    { symbol: 'DN', bars: flatBars() },
    { symbol: 'SPY', bars: flatBars() },
    { symbol: 'OLD', bars: flatBars().filter((bar) => bar.date <= '2026-09-01') },
    { symbol: 'THIN', bars: flatBars({ '2026-09-29': { volume: 1_999_999 } }) },
    { symbol: 'EDGE', bars: flatBars({ '2026-09-29': { volume: 2_000_000 } }) },
  ]);
  bars.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP,DN,ZZZ,OLD,THIN,EDGE"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\n');
  const storePath = join(directory, 'v2.sqlite');
  const db = migratedMemoryStore();
  if (capital) {
    new CapitalConfigStore(db, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
      2026,
      10_000,
      1_500,
    );
  }
  writeFileSync(storePath, db.serialize());
  db.close();
  return {
    directory,
    storePath,
    base: {
      barStoreRoot,
      constituentsPath,
      fxPath,
      spreadsPath,
      saxoSpreadsPath: join(directory, 'none.csv'),
    },
  };
}

const PASS_SCRIPT: Script = () => '{"veto": false, "reason": "trend is flat, stop outside noise"}';

function transportsFor(script: Script, transports: ScriptedTransport[]) {
  return (pin: ModelPin): AnthropicMessagesClient => {
    const transport = new ScriptedTransport(pin, script);
    transports.push(transport);
    return transport;
  };
}

interface Opened {
  readonly root: V2Root;
  readonly signals: SignalStore;
  readonly transports: ScriptedTransport[];
}

function open(
  fixtures: Fixtures,
  clock: SimulatedClock,
  extra: Partial<V2RootOptions> = {},
  script: Script = PASS_SCRIPT,
): Opened {
  const transports: ScriptedTransport[] = [];
  const root = composeV2Root({
    ...fixtures.base,
    tradingDate: clock.now().toISOString().slice(0, 10),
    dryRun: true,
    storePath: fixtures.storePath,
    clock,
    logger: { log: () => {} },
    transportFor: transportsFor(script, transports),
    newsSource: { headlines: () => Promise.resolve([]) },
    ...extra,
  });
  roots.push(root);
  const handle = openSharedStore(fixtures.storePath);
  handles.push(handle);
  return { root, signals: new SignalStore(guardedStore(handle, 'v2'), clock), transports };
}

function post(
  signals: SignalStore,
  value: Record<string, unknown>,
  receivedAt: Date = IN_SESSION,
): string {
  const parsed = parseSignalPayload({
    symbol: 'UP',
    entry: 25,
    targets: [25.6, 26, 26.4],
    stop: 24.5,
    ...value,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return signals.record(parsed.payload, receivedAt, classifySignalWindow(receivedAt, CALENDAR))
    .signal.signal_id;
}

function quotesAt(...quotes: LatestQuote[]): LatestQuoteSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    latestQuote: (symbol) => {
      reads.push(symbol);
      const quote = quotes.length > 1 ? quotes.shift() : quotes[0];
      return quote === undefined ? Promise.reject(new Error('no quote')) : Promise.resolve(quote);
    },
  };
}

function quote(ask: number, at: Date = new Date(IN_SESSION.getTime() + 1_000)): LatestQuote {
  return { ask, bid: ask - 0.02, quoted_at: at.toISOString() };
}

function hold(root: V2Root, bookId: string, instrument: string): void {
  root.books.applyFill(bookId, {
    instrument,
    venue: 'alpaca',
    side: 'buy',
    leg: 'entry',
    qty: 1,
    priceGbp: 20,
    feeGbp: 0,
    clientOrderId: `held-${bookId}`,
    tradingDate: '2026-09-29',
    stopGbp: undefined,
    targetGbp: undefined,
  });
}

function refusalsOf(root: V2Root, parameter: string) {
  return root.db
    .prepare(
      'SELECT scope, parameter, ticket, message, book_id, instrument FROM v2_refusals WHERE parameter = ?',
    )
    .all(parameter);
}

function primaryId(signalId: string, symbol = 'UP'): string {
  return `v2-signals-primary-${symbol}-${signalId}`;
}

function shadowId(signalId: string, symbol = 'UP'): string {
  return `v2-signals-no-veto-${symbol}-${signalId}`;
}

describe('signals sleeve capital (David 2026-09-30, doc 66 D8)', () => {
  it('seeds both books at the 70% share of a £10,000 year, with the loss and daily caps following it', async () => {
    const fixtures = await writeFixtures();
    const { root } = open(fixtures, new SimulatedClock(IN_SESSION));
    expect(root.books.cash('signals/primary')).toBe(7_000);
    expect(root.books.cash('signals/no-veto')).toBe(7_000);
    expect(root.books.cash('debate/primary')).toBe(3_000);
    const capital = root.capital.inForce(D);
    if (capital === undefined) throw new Error('capital config missing');
    const share = sleeveCapitalYear(SIGNALS_SLEEVE_SPEC, capital);
    expect(share.startCapitalGbp).toBe(7_000);
    expect(share.lossCapGbp).toBeCloseTo(1_050, 9);
    expect(dailyCapGbp(share)).toBeCloseTo(70, 9);
  });

  it('keeps signals/primary and debate/primary on separate budgets: a signals loss leaves debate at full size', async () => {
    const fixtures = await writeFixtures();
    const { root } = open(fixtures, new SimulatedClock(IN_SESSION));
    const { books } = root;
    const leg = { instrument: 'UP', venue: 'alpaca' as const, qty: 1, feeGbp: 0, tradingDate: D };
    books.applyFill('signals/primary', {
      ...leg,
      side: 'buy',
      leg: 'entry',
      priceGbp: 700,
      clientOrderId: 'a',
      stopGbp: undefined,
      targetGbp: undefined,
    });
    books.applyFill('signals/primary', {
      ...leg,
      side: 'sell',
      leg: 'exit',
      priceGbp: 100,
      clientOrderId: 'a',
      stopGbp: undefined,
      targetGbp: undefined,
    });
    const flat = () => undefined;
    expect(books.markDay('signals/primary', D, flat, 1).state.sizeMultiplier).toBe(0.5);
    expect(books.markDay('debate/primary', D, flat, 1).state.sizeMultiplier).toBe(1);
    expect(books.lastDay('debate/primary')?.state).toMatchObject({
      sizeMultiplier: 1,
      entriesBlockedAtNextFill: false,
    });
  });
});

describe('processSignals, dry run', () => {
  it('enters a limit bracket in both books: the signal stop, the first target at 2R, full-R size', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, { size: 0.25, trail_after: 25.8, source: 'desk' });

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ ran: true, outcomes: [{ signal_id: id, status: 'processed' }] });
    const primary = root.journal.orderFor(primaryId(id));
    expect(primary).toMatchObject({
      book_id: 'signals/primary',
      trading_date: D,
      leg: 'entry',
      side: 'buy',
      dry_run: true,
      payload: { price: 25, stop: 24.5, target: 26, size: 35 },
    });
    expect(root.journal.orderFor(shadowId(id))).toMatchObject({
      book_id: 'signals/no-veto',
      outcome: 'simulated',
      payload: { price: 25, stop: 24.5, target: 26, size: 35 },
    });
    expect(signals.get(id)?.status).toBe('processed');
    const decisions = root.db
      .prepare(
        'SELECT book_id, action, size_shares, stop_price, payload FROM v2_decisions ORDER BY book_id',
      )
      .all() as { book_id: string; action: string; size_shares: number; payload: string }[];
    expect(decisions.map((row) => [row.book_id, row.action, row.size_shares])).toEqual([
      ['signals/no-veto', 'enter_long', 35],
      ['signals/primary', 'enter_long', 35],
    ]);
    const { reason } = root.db
      .prepare("SELECT reason FROM v2_decisions WHERE book_id = 'signals/primary'")
      .get() as { reason: string };
    expect(reason).toMatch(new RegExp(`^signal ${id}: limit 25 stop 24.5 target 26; veto pass`));
    expect(JSON.parse(decisions[1]?.payload ?? '{}')).toMatchObject({
      signal_id: id,
      size_hint: 0.25,
      trail_after: 25.8,
      source: 'desk',
      last_close: 25,
      r: 0.5,
      veto_kind: 'pass',
      veto_reason: 'trend is flat, stop outside noise',
    });
    const prompts = transports.flatMap((transport) => transport.calls.map((call) => call.prompt));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Signal veto persona');
    expect(prompts[0]).toContain('"symbol": "UP"');
    const data = (prompts[0] ?? '').replace(SIGNAL_VETO_PROMPT, '');
    expect(data).not.toMatch(/size|equity|cash|book|position|account|desk|7000|api[_-]?key/i);
  });

  it('enters a buy-stop in both books with its trigger; the shadow fills at the trigger, not the open', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const { root, signals } = open(fixtures, clock);
    const id = post(signals, { entry: 25.15, targets: [26, 27] });

    await root.processSignals(signals, IN_SESSION);

    for (const orderId of [primaryId(id), shadowId(id)]) {
      expect(root.journal.orderFor(orderId)).toMatchObject({
        payload: { price: 25.15, trigger: 25.15, stop: 24.5, target: 27 },
      });
    }
    const reason = root.db
      .prepare("SELECT reason FROM v2_decisions WHERE book_id = 'signals/primary'")
      .get() as { reason: string };
    expect(reason.reason).toContain('buy-stop 25.15 limit 25.15 stop 24.5 target 27');

    clock.advanceTo(new Date('2026-10-01T06:30:00.000Z'));
    const next = open(fixtures, clock);
    await next.root.run();
    const fill = next.root.db
      .prepare("SELECT price_gbp FROM v2_fills WHERE book_id = 'signals/no-veto' AND leg = 'entry'")
      .get() as { price_gbp: number };
    expect(fill.price_gbp).toBeCloseTo(25.15 / 1.25, 9);
  });

  it('shows the signal decisions and signal refusals in the dashboard journal', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    post(signals, {});
    post(signals, { symbol: 'NOPE' });
    await root.processSignals(signals, IN_SESSION);

    const journal = new JournalReader(root.db).read({ limit: 50 });
    const day = journal.days.find((candidate) => candidate.trading_date === D);
    expect(day?.decisions.map((decision) => decision.book_id).sort()).toEqual([
      'signals/no-veto',
      'signals/primary',
    ]);
    expect(day?.refusals).toContainEqual(
      expect.objectContaining({ scope: 'signal', parameter: 'not_in_universe', book_id: null }),
    );
  });

  it('turns a veto into a skip on the primary while the shadow still enters', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      {},
      () => '{"veto": true, "reason": "stop sits inside daily noise"}',
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toMatchObject({ outcome: 'simulated' });
    const primary = root.db
      .prepare("SELECT action, reason FROM v2_decisions WHERE book_id = 'signals/primary'")
      .get() as { action: string; reason: string };
    expect(primary).toEqual({
      action: 'skip',
      reason: 'vetoed: veto: stop sits inside daily noise',
    });
    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(
      /^veto veto: stop sits inside daily noise;/,
    );
  });

  it('holds both legs after a failed veto call, failing the signal for a later pass', async () => {
    const fixtures = await writeFixtures();
    const failing = (_request: AnthropicMessageRequest): string => {
      throw new Error('upstream 503');
    };
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION), {}, failing);
    const id = post(signals, {});

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({
      outcomes: [
        {
          status: 'failed',
          detail: 'veto llm_call_failed: upstream 503; one retry left on a later pass',
        },
      ],
    });
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toBeUndefined();
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_decisions').get()).toEqual({ n: 0 });
  });

  it('marks a signal whose entry order already exists processed without a second veto or order', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {});
    await root.processSignals(signals, IN_SESSION);
    signals.appendEvent(id, 'queued', 'replayed after a crash');

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({
      ran: true,
      outcomes: [{ status: 'processed', detail: expect.stringMatching(/^already_submitted/) }],
    });
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 2 });
  });

  it.each([
    ['not_in_universe', { symbol: 'NOPE' }, 'NOPE is not a current S&P 500 constituent'],
    ['stale_last_close', { symbol: 'ZZZ' }, 'last bar none before 2026-09-30'],
    ['stale_last_close', { symbol: 'OLD' }, 'last bar 2026-09-01 before 2026-09-30'],
    ['last_close_at_or_below_stop', { entry: 26, stop: 25, targets: [28] }, 'last close 25'],
  ])('refuses %s in both books and journals it', async (code, value, detail) => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, value);

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ ran: true, outcomes: [{ status: 'refused' }] });
    expect(signals.get(id)?.events.at(-1)).toMatchObject({
      status: 'refused',
      detail: expect.stringMatching(new RegExp(`^${code}: `)),
    });
    expect(signals.get(id)?.events.at(-1)?.detail).toContain(detail);
    expect(refusalsOf(root, code)).toEqual([
      expect.objectContaining({ scope: 'signal', ticket: '#1941', book_id: null }),
    ]);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });
  });

  it('refuses a symbol already held or resting in a signals book or a broker-routed book', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    root.journal.recordOrder({
      client_order_id: 'resting-dn',
      decision_id: null,
      book_id: 'signals/no-veto',
      trading_date: D,
      instrument: 'DN',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: true,
      outcome: 'simulated',
      payload: { size: 1, price: 25 },
    });
    post(signals, { symbol: 'DN' });

    await root.processSignals(signals, IN_SESSION);

    expect(refusalsOf(root, 'symbol_held')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('held or resting in signals/no-veto'),
      }),
    ]);
  });

  it('enters no book halted by its loss budget, while the shadow still takes the signal', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const leg = {
      instrument: 'DN',
      venue: 'alpaca' as const,
      qty: 1,
      feeGbp: 0,
      tradingDate: '2026-09-29',
      clientOrderId: 'loss',
      stopGbp: undefined,
      targetGbp: undefined,
    };
    root.books.applyFill('signals/primary', { ...leg, side: 'buy', leg: 'entry', priceGbp: 1_200 });
    root.books.applyFill('signals/primary', { ...leg, side: 'sell', leg: 'exit', priceGbp: 100 });
    expect(
      root.books.markDay('signals/primary', '2026-09-29', () => undefined, 1).state.halted,
    ).toBe(true);
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toMatchObject({ outcome: 'simulated' });
    expect(
      root.db.prepare('SELECT book_id, size_shares FROM v2_decisions ORDER BY book_id').all(),
    ).toEqual([
      { book_id: 'signals/no-veto', size_shares: 35 },
      { book_id: 'signals/primary', size_shares: 0 },
    ]);
    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(/entries 1, submitted 0, simulated 1/);
  });

  it('refuses a signal whose own session has passed', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {}, new Date('2026-09-29T14:00:00.000Z'));

    await root.processSignals(signals, IN_SESSION);

    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(/^session_missed: /);
  });

  it('refuses every signal while the manual control is paused', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    root.db
      .prepare(
        "INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES ('pause', 'news day', 'test', 'k1', ?)",
      )
      .run(IN_SESSION.toISOString());
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(signals.get(id)?.events.at(-1)?.detail).toBe('manual_control_paused: news day');
  });

  it('refuses every signal while no capital config is in force', async () => {
    const fixtures = await writeFixtures(false);
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(/^no_capital_config: /);
  });

  it('does nothing while the market is closed or nothing is due', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    expect(await root.processSignals(signals, IN_SESSION)).toMatchObject({
      ran: false,
      reason: 'nothing_due',
    });
    const id = post(signals, {}, new Date(`${D}T21:00:00.000Z`));
    expect(await root.processSignals(signals, new Date(`${D}T21:00:01.000Z`))).toMatchObject({
      ran: false,
      reason: 'nothing_due',
    });
    expect(signals.get(id)?.status).toBe('queued');
  });

  it('refuses a symbol with an open position in a signals book', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    hold(root, 'signals/primary', 'DN');
    post(signals, { symbol: 'DN' });

    await root.processSignals(signals, IN_SESSION);

    expect(refusalsOf(root, 'symbol_held')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('held or resting in signals/primary'),
      }),
    ]);
  });

  it('ignores a simulated book of another sleeve holding the symbol', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    hold(root, 'debate/primary', 'DN');
    const id = post(signals, { symbol: 'DN' });

    await root.processSignals(signals, IN_SESSION);

    expect(signals.get(id)?.status).toBe('processed');
  });

  it('records a failed signal and carries on with the next', async () => {
    const fixtures = await writeFixtures();
    const logs: LogEntry[] = [];
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION), {
      logger: { log: (entry) => logs.push(entry) },
    });
    const first = post(signals, {}, new Date(IN_SESSION.getTime() - 1_000));
    const second = post(signals, { symbol: 'DN' });
    const recordDecision = root.journal.recordDecision.bind(root.journal);
    let calls = 0;
    vi.spyOn(root.journal, 'recordDecision').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return recordDecision(...args);
    });

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({
      ran: true,
      outcomes: [
        { signal_id: first, status: 'failed', detail: 'disk full' },
        { signal_id: second, status: 'processed' },
      ],
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        event: 'v2_signal_failed',
        trace_id: `v2-signal-${first}`,
        message: `UP ${first}: disk full`,
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'info', event: 'v2_signal_processed', stage: 'v2' }),
    );
  });
});

describe('failed signals retry inside their window (David 2026-10-05, #2024)', () => {
  it('retries a failed signal on a later pass of its session and enters it', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {});
    const recordDecision = root.journal.recordDecision.bind(root.journal);
    let calls = 0;
    vi.spyOn(root.journal, 'recordDecision').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return recordDecision(...args);
    });

    const failed = await root.processSignals(signals, IN_SESSION);
    const retried = await root.processSignals(signals, new Date(IN_SESSION.getTime() + 30_000));

    expect(failed).toMatchObject({ outcomes: [{ status: 'failed', detail: 'disk full' }] });
    expect(retried).toMatchObject({ outcomes: [{ signal_id: id, status: 'processed' }] });
    expect(signals.get(id)?.events.map((event) => event.status)).toEqual([
      'queued',
      'failed',
      'processed',
    ]);
    expect(root.journal.orderFor(primaryId(id))).toBeDefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(
      await root.processSignals(signals, new Date(IN_SESSION.getTime() + 60_000)),
    ).toMatchObject({ ran: false, reason: 'nothing_due' });
  });

  it('drops a failed signal once its session has passed, journalling the last error', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {}, new Date('2026-09-29T14:00:00.000Z'));
    signals.appendEvent(id, 'failed', 'disk full');
    signals.appendEvent(id, 'failed', 'broker timeout');

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ ran: true, outcomes: [{ signal_id: id, status: 'refused' }] });
    expect(signals.get(id)?.events.at(-1)?.detail).toBe(
      'dropped: validity window ended (due in the 2026-09-29T14:00:00.000Z session), last error: broker timeout',
    );
    expect(refusalsOf(root, 'dropped')).toEqual([
      expect.objectContaining({
        scope: 'signal',
        ticket: '#2024',
        instrument: 'UP',
        message: expect.stringContaining('last error: broker timeout'),
      }),
    ]);
    expect(refusalsOf(root, 'session_missed')).toEqual([]);
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(0);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });
  });
});

describe('both legs fill at the first quote after the signal (David 2026-10-08, #2024)', () => {
  function shadowEntryFill(root: V2Root): { price_gbp: number } | undefined {
    return root.db
      .prepare("SELECT price_gbp FROM v2_fills WHERE book_id = 'signals/no-veto' AND leg = 'entry'")
      .get() as { price_gbp: number } | undefined;
  }

  it('journals the first quote on both entries and fills the shadow at its ask, not the bar', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const quotes = quotesAt(quote(24.96));
    const { root, signals } = open(fixtures, clock, { quotes });
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    const entryQuote = {
      ask: 24.96,
      bid: 24.94,
      quoted_at: '2026-09-30T14:00:01.000Z',
      fill: 24.96,
    };
    expect(quotes.reads).toEqual(['UP']);
    for (const orderId of [primaryId(id), shadowId(id)]) {
      expect(root.journal.orderFor(orderId)?.payload).toMatchObject({ entry_quote: entryQuote });
    }
    const decision = root.db
      .prepare("SELECT payload FROM v2_decisions WHERE book_id = 'signals/no-veto'")
      .get() as { payload: string };
    expect(JSON.parse(decision.payload)).toMatchObject({ entry_quote: entryQuote });

    clock.advanceTo(new Date('2026-10-01T06:30:00.000Z'));
    const next = open(fixtures, clock);
    await next.root.run();
    expect(shadowEntryFill(next.root)?.price_gbp).toBeCloseTo(24.96 / 1.25, 9);
  });

  it('keeps the shadow pending through its session when the first quote misses, then a no-fill', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const { root, signals } = open(fixtures, clock, { quotes: quotesAt(quote(25.3)) });
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    expect(root.journal.orderFor(shadowId(id))?.payload).toMatchObject({
      entry_quote: { ask: 25.3, fill: null },
    });
    post(signals, { source: 'again' }, new Date(IN_SESSION.getTime() + 5_000));
    await root.processSignals(signals, new Date(IN_SESSION.getTime() + 30_000));
    expect(refusalsOf(root, 'symbol_held')).toHaveLength(1);

    clock.advanceTo(new Date('2026-10-01T06:30:00.000Z'));
    const next = open(fixtures, clock);
    await next.root.run();
    expect(next.root.journal.orderFor(shadowId(id))?.outcome).toBe('cancelled');
    expect(shadowEntryFill(next.root)).toBeUndefined();
    expect(next.root.books.position('signals/no-veto', 'UP')).toBeUndefined();
  });

  it('fails a signal whose latest quote predates its arrival, and enters it on a later quote', async () => {
    const fixtures = await writeFixtures();
    const quotes = quotesAt(
      quote(25, new Date(IN_SESSION.getTime() - 1)),
      quote(25, new Date(IN_SESSION.getTime() + 20_000)),
    );
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION), { quotes });
    const id = post(signals, {});

    const failed = await root.processSignals(signals, IN_SESSION);
    expect(failed).toMatchObject({
      outcomes: [
        {
          status: 'failed',
          detail: `no UP quote since ${IN_SESSION.toISOString()}: latest 2026-09-30T13:59:59.999Z`,
        },
      ],
    });
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });

    await root.processSignals(signals, new Date(IN_SESSION.getTime() + 30_000));
    expect(root.journal.orderFor(shadowId(id))?.payload).toMatchObject({
      entry_quote: { quoted_at: '2026-09-30T14:00:20.000Z', fill: 25 },
    });
  });

  it('takes the first quote after the next open for an out-of-session signal', async () => {
    const fixtures = await writeFixtures();
    const open930 = new Date(`${D}T13:30:00.000Z`);
    const quotes = quotesAt(
      quote(25, new Date(open930.getTime() - 1_000)),
      quote(24.99, new Date(open930.getTime() + 2_000)),
    );
    const { root, signals } = open(fixtures, new SimulatedClock(open930), { quotes });
    const id = post(signals, {}, new Date(`${D}T02:00:00.000Z`));
    expect(signals.get(id)?.process_after).toBe(open930.toISOString());

    const early = await root.processSignals(signals, new Date(open930.getTime() + 1_000));
    const late = await root.processSignals(signals, new Date(open930.getTime() + 30_000));

    expect(early).toMatchObject({ outcomes: [{ status: 'failed' }] });
    expect(late).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(root.journal.orderFor(shadowId(id))?.payload).toMatchObject({
      entry_quote: { ask: 24.99, fill: 24.99 },
    });
  });

  it('refuses an off-list symbol before any quote, veto or order in either book', async () => {
    const fixtures = await writeFixtures();
    const quotes = quotesAt(quote(25));
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION), {
      quotes,
    });
    post(signals, { symbol: 'NOPE' });

    await root.processSignals(signals, IN_SESSION);

    expect(refusalsOf(root, 'not_in_universe')).toHaveLength(1);
    expect(quotes.reads).toEqual([]);
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(0);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });
  });
});

describe('the veto-rate cap over a rolling 20 signals (David 2026-10-05, #2024)', () => {
  const VETO_SCRIPT: Script = () => '{"veto": true, "reason": "stop sits inside daily noise"}';
  const passes = (count: number): ('pass' | 'veto')[] => Array<'pass'>(count).fill('pass');

  function seedVerdicts(signals: SignalStore, verdicts: readonly ('pass' | 'veto')[]): void {
    for (const [index, verdict] of verdicts.entries()) {
      const id = post(signals, { entry: 25 + (index + 1) / 100 });
      signals.appendEvent(id, 'processed', `veto ${verdict}: seeded; entries 0`);
    }
  }

  function faultsOf(root: V2Root) {
    return root.db.prepare('SELECT kind, trading_date, code, detail FROM v2_faults').all();
  }

  it('raises a veto_rate fault at 3 of the last 20, while the veto still skips the primary', async () => {
    const fixtures = await writeFixtures();
    const logs: LogEntry[] = [];
    const { root, signals } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      { logger: { log: (entry) => logs.push(entry) } },
      VETO_SCRIPT,
    );
    seedVerdicts(signals, ['veto', 'pass', 'veto', ...passes(16)]);
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    const detail = '3 of the last 20 signals vetoed, above the 10% cap';
    expect(faultsOf(root)).toEqual([
      { kind: 'veto_rate', trading_date: D, code: 'SIGNAL_VETO_RATE', detail },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'v2_signal_veto_rate', message: detail }),
    );
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
    expect(root.faults.faultFreeWeeks(D).last_fault).toBe(D);
  });

  it('raises nothing at 2 of the last 20', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    seedVerdicts(signals, ['veto', 'veto', ...passes(17)]);
    post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(faultsOf(root)).toEqual([]);
  });

  it('raises nothing before 20 verdicts exist, however many are vetoes', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION), {}, VETO_SCRIPT);
    seedVerdicts(signals, ['veto', 'veto', ...passes(16)]);
    post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(faultsOf(root)).toEqual([]);
  });

  it('skips a veto that could not run: it is not a verdict', async () => {
    const fixtures = await writeFixtures();
    const failing = (_request: AnthropicMessageRequest): string => {
      throw new Error('upstream 503');
    };
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION), {}, failing);
    seedVerdicts(signals, ['veto', 'veto', 'veto', ...passes(16)]);
    post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(faultsOf(root)).toEqual([]);
  });
});

describe('the run lease between the processor and the cycle', () => {
  it('skips a signals pass while the cycle holds the lease, leaving the signal queued', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const { root, signals } = open(fixtures, clock);
    const id = post(signals, {});
    const release = new RunLease(root.db, clock).tryAcquire('cycle');

    expect(await root.processSignals(signals, IN_SESSION)).toMatchObject({
      ran: false,
      reason: 'lease_held',
      detail: `cycle (pid ${process.pid})`,
    });
    expect(signals.get(id)?.status).toBe('queued');
    release?.();
    expect(await root.processSignals(signals, IN_SESSION)).toMatchObject({ ran: true });
  });

  it('the cycle refuses to run beside a signals pass that outlasts its wait', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(new Date(`${D}T06:30:00.000Z`));
    const { root } = open(fixtures, clock, {
      leaseWait: { timeoutMs: 0, pollMs: 1, sleep: () => Promise.resolve(), nowMs: () => 0 },
    });
    new RunLease(root.db, clock).tryAcquire('signals');

    await expect(root.run()).rejects.toThrow(
      /v2 run lease not acquired for cycle within 0 ms: held by signals/,
    );
    expect(root.books.isMarked(D)).toBe(false);
  });
});

describe('long-lived store handles (#2012)', () => {
  it('signals passes and cycles prepare no new statements once every query has run once', async () => {
    const prepare = vi.spyOn(BetterSqlite3.prototype, 'prepare');
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const pass = async (i: number): Promise<void> => {
      post(signals, { source: `desk-${i}` });
      await root.processSignals(signals, IN_SESSION);
      signals.due(IN_SESSION);
      await root.run();
    };
    for (let i = 0; i < 3; i++) await pass(i);
    const warm = prepare.mock.calls.length;

    for (let i = 3; i < 23; i++) await pass(i);

    expect(warm).toBeGreaterThan(0);
    expect(prepare.mock.calls.length).toBe(warm);
  });
});

function fakeAlpaca(
  clock: SimulatedClock,
  fills = true,
): AlpacaBrokerClient & { orders: AlpacaOrder[] } {
  const orders: AlpacaOrder[] = [];
  const filled = (order: AlpacaOrder): AlpacaOrder => (fills ? filledAt(order, clock) : order);
  return client(orders, filled);
}

// A filled bracket as measured in #2086: the take-profit rests `new` and the stop stays `held`, off
// the open listing
function filledAt(order: AlpacaOrder, clock: SimulatedClock): AlpacaOrder {
  return {
    ...order,
    status: 'filled',
    filled_qty: order.qty,
    filled_avg_price: order.limit_price ?? '0',
    filled_at: clock.now().toISOString(),
    legs: (order.legs ?? []).map((leg) => ({
      ...leg,
      status: leg.type === 'stop' ? 'held' : 'new',
    })),
  };
}

function openParts(order: AlpacaOrder): AlpacaOrder[] {
  const { legs, ...parent } = order;
  if (order.status !== 'filled') return [parent];
  return (legs ?? [])
    .filter((leg) => leg.status === 'new')
    .map((leg) => ({
      ...leg,
      client_order_id: leg.client_order_id ?? leg.id,
      symbol: order.symbol,
      side: leg.side ?? order.side,
      qty: leg.qty ?? order.qty,
      order_class: order.order_class,
    }));
}

function client(
  orders: AlpacaOrder[],
  filled: (order: AlpacaOrder) => AlpacaOrder,
): AlpacaBrokerClient & { orders: AlpacaOrder[] } {
  return {
    orders,
    submitOrder: vi.fn((request) => {
      const id = `alp-${orders.length + 1}`;
      const leg = (suffix: string, type: 'limit' | 'stop') => ({
        id: `${id}-${suffix}`,
        client_order_id: `${id}-${suffix}-uuid`,
        side: request.side === 'buy' ? ('sell' as const) : ('buy' as const),
        qty: request.qty,
        type,
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      });
      const order: AlpacaOrder = {
        id,
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
          { ...leg('tp', 'limit'), limit_price: request.take_profit.limit_price },
          { ...leg('sl', 'stop'), stop_price: request.stop_loss.stop_price },
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
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    listOpenOrders: vi.fn(() => Promise.resolve(orders.map(filled).flatMap(openParts))),
    listOrderHistory: vi.fn((symbols: readonly string[]) =>
      Promise.resolve(orders.filter((order) => symbols.includes(order.symbol)).map(filled)),
    ),
    getPositions: vi.fn(() =>
      Promise.resolve(
        orders
          .map(filled)
          .filter((order) => order.status === 'filled')
          .map((order) => ({
            symbol: order.symbol,
            qty: order.qty,
            side: 'long' as const,
            avg_entry_price: order.limit_price ?? '0',
          })),
      ),
    ),
    getAccount: vi.fn().mockResolvedValue({ cash: '100000', equity: '100000' }),
  };
}

describe('processSignals, paper with a fake Alpaca', () => {
  const paper = (alpacaClient: AlpacaBrokerClient): Partial<V2RootOptions> => ({
    dryRun: false,
    nousBaseUrl: 'https://nous.test/v1',
    nousApiKey: 'present',
    alpacaClient,
    constituents: () => ['UP', 'DN'],
    quotes: quotesAt(quote(25)),
  });

  it('blocks the primary without a clean Alpaca reconcile for the day; the shadow still enters', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const alpaca = fakeAlpaca(clock);
    const { root, signals } = open(fixtures, clock, paper(alpaca));
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);

    expect(alpaca.submitOrder).not.toHaveBeenCalled();
    expect(root.journal.orderFor(shadowId(id))).toMatchObject({ outcome: 'simulated' });
    expect(refusalsOf(root, 'reconcile_not_clean')).toEqual([
      expect.objectContaining({
        book_id: 'signals/primary',
        instrument: 'UP',
        message: `signals/primary UP: signal ${id} not entered, no clean ${D} reconcile`,
      }),
    ]);
    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(/; reconcile blocked signals\/primary$/);
  });

  it('refuses a symbol a broker-routed book of another sleeve holds', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const { root, signals } = open(fixtures, clock, paper(fakeAlpaca(clock)));
    hold(root, 'debate/primary', 'DN');
    post(signals, { symbol: 'DN' });

    await root.processSignals(signals, IN_SESSION);

    expect(refusalsOf(root, 'symbol_held')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('held or resting in debate/primary'),
      }),
    ]);
  });

  it('submits the primary bracket, then the cycles fill both books and close the shadow at its target', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const alpaca = fakeAlpaca(clock);
    const day = open(fixtures, clock, paper(alpaca));
    day.root.journal.recordReconcile({
      trading_date: D,
      venue: 'alpaca',
      source: 'broker',
      status: 'clean',
      book_ids: ['debate/primary', 'signals/primary'],
      diffs: [],
      detail: '',
      broker_mode: 'paper',
      cash_quote: null,
    });
    const id = post(day.signals, {});

    await day.root.processSignals(day.signals, IN_SESSION);

    expect(alpaca.submitOrder).toHaveBeenCalledTimes(1);
    expect(alpaca.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        client_order_id: primaryId(id),
        symbol: 'UP',
        side: 'buy',
        qty: '35',
        limit_price: '25.00',
        order_class: 'bracket',
        time_in_force: 'gtc',
        take_profit: { limit_price: '26.00' },
        stop_loss: { stop_price: '24.50' },
      }),
    );
    expect(day.root.journal.orderFor(primaryId(id))).toMatchObject({ outcome: 'submitted' });

    clock.advanceTo(new Date('2026-10-01T06:30:00.000Z'));
    const next = open(fixtures, clock, paper(alpaca));
    await next.root.run();
    expect(next.root.books.position('signals/primary', 'UP')?.qty).toBe(35);
    expect(next.root.books.position('signals/no-veto', 'UP')).toMatchObject({
      qty: 35,
      stopGbp: expect.any(Number),
      targetGbp: expect.any(Number),
    });

    clock.advanceTo(new Date('2026-10-02T06:30:00.000Z'));
    const after = open(fixtures, clock, paper(alpaca));
    await after.root.run();
    expect(after.root.books.position('signals/no-veto', 'UP')).toBeUndefined();
    expect(after.root.books.position('signals/primary', 'UP')?.qty).toBe(35);
    expect(
      after.root.db
        .prepare(
          "SELECT trading_date, status FROM v2_reconciles WHERE source = 'broker' AND trading_date > ?",
        )
        .all(D),
    ).toEqual([
      { trading_date: '2026-10-01', status: 'clean' },
      { trading_date: '2026-10-02', status: 'clean' },
    ]);
  });

  it('submits a buy-stop primary as a stop-limit parent: stop at the zone low, limit at its high', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const alpaca = fakeAlpaca(clock, false);
    const day = open(fixtures, clock, paper(alpaca));
    day.root.journal.recordReconcile({
      trading_date: D,
      venue: 'alpaca',
      source: 'broker',
      status: 'clean',
      book_ids: ['signals/primary'],
      diffs: [],
      detail: '',
      broker_mode: 'paper',
      cash_quote: null,
    });
    const id = post(day.signals, { entry: [25.5, 25.6], targets: [26, 27] });

    await day.root.processSignals(day.signals, IN_SESSION);

    expect(alpaca.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        client_order_id: primaryId(id),
        limit_price: '25.60',
        stop_price: '25.50',
        order_class: 'bracket',
        take_profit: { limit_price: '27.00' },
        stop_loss: { stop_price: '24.50' },
      }),
    );
    expect(day.root.journal.orderFor(primaryId(id))).toMatchObject({ outcome: 'submitted' });
  });

  it('retries a signal that failed after its primary reached Alpaca without sending it again (#2024)', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const alpaca = fakeAlpaca(clock, false);
    const day = open(fixtures, clock, paper(alpaca));
    day.root.journal.recordReconcile({
      trading_date: D,
      venue: 'alpaca',
      source: 'broker',
      status: 'clean',
      book_ids: ['signals/primary'],
      diffs: [],
      detail: '',
      broker_mode: 'paper',
      cash_quote: null,
    });
    const id = post(day.signals, {});
    vi.spyOn(day.root.journal, 'settleOrder').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const failed = await day.root.processSignals(day.signals, IN_SESSION);
    const retried = await day.root.processSignals(
      day.signals,
      new Date(IN_SESSION.getTime() + 30_000),
    );

    expect(failed).toMatchObject({ outcomes: [{ status: 'failed', detail: 'disk full' }] });
    expect(retried).toMatchObject({
      outcomes: [{ status: 'processed', detail: expect.stringMatching(/^already_submitted/) }],
    });
    expect(alpaca.submitOrder).toHaveBeenCalledTimes(1);
    expect(day.root.journal.orderFor(primaryId(id))).toMatchObject({ outcome: 'pending' });
  });

  it('cancels an unfilled signal entry at the next daily cycle', async () => {
    const fixtures = await writeFixtures();
    const clock = new SimulatedClock(IN_SESSION);
    const alpaca = fakeAlpaca(clock, false);
    const day = open(fixtures, clock, paper(alpaca));
    day.root.journal.recordReconcile({
      trading_date: D,
      venue: 'alpaca',
      source: 'broker',
      status: 'clean',
      book_ids: ['signals/primary'],
      diffs: [],
      detail: '',
      broker_mode: 'paper',
      cash_quote: null,
    });
    const id = post(day.signals, {});
    await day.root.processSignals(day.signals, IN_SESSION);

    clock.advanceTo(new Date('2026-10-01T06:30:00.000Z'));
    await open(fixtures, clock, paper(alpaca)).root.run();

    expect(alpaca.cancelOrder).toHaveBeenCalledTimes(1);
    const reopened = open(fixtures, clock, paper(alpaca)).root;
    expect(reopened.journal.orderFor(primaryId(id))?.outcome).toBe('cancelled');
    expect(reopened.books.position('signals/primary', 'UP')).toBeUndefined();
  });

  it('refuses a signal below the $50M dollar-volume floor before any quote, veto or order (#2024)', async () => {
    const fixtures = await writeFixtures();
    const quotes = quotesAt(quote(25));
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION), {
      quotes,
    });
    const id = post(signals, { symbol: 'THIN' });

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ outcomes: [{ status: 'refused' }] });
    expect(signals.get(id)?.events.at(-1)?.detail).toBe(
      'below_dollar_volume_floor: last bar 2026-09-29 dollar volume 49999975 below 50000000',
    );
    expect(refusalsOf(root, 'below_dollar_volume_floor')).toEqual([
      expect.objectContaining({
        scope: 'signal',
        ticket: '#2024',
        book_id: null,
        instrument: 'THIN',
      }),
    ]);
    expect(quotes.reads).toEqual([]);
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(0);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });
  });

  it('admits a signal whose last bar sits exactly on the dollar-volume floor', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, { symbol: 'EDGE' });

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(root.journal.orderFor(shadowId(id, 'EDGE'))).toBeDefined();
  });
});

describe('the veto runs once per signal (David 2026-10-09, #2024)', () => {
  const STALE = quote(25, new Date(IN_SESSION.getTime() - 1));
  const FRESH = quote(25, new Date(IN_SESSION.getTime() + 20_000));

  function decisionRows(root: V2Root, signalId: string): readonly string[] {
    const rows = root.db
      .prepare(
        `SELECT book_id, trading_date, instrument, action, reason, payload
         FROM v2_decisions ORDER BY book_id`,
      )
      .all();
    return rows.map((row) => JSON.stringify(row).replaceAll(signalId, '<signal>'));
  }

  it('a retry after a stale quote makes no second LLM call and reuses the journalled verdict', async () => {
    const fixtures = await writeFixtures();
    const quotes = quotesAt(STALE, STALE, FRESH);
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION), {
      quotes,
    });
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    await root.processSignals(signals, new Date(IN_SESSION.getTime() + 30_000));
    const entered = await root.processSignals(signals, new Date(IN_SESSION.getTime() + 60_000));

    expect(entered).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(quotes.reads).toEqual(['UP', 'UP', 'UP']);
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(signals.vetoFor(id)).toEqual({
      kind: 'pass',
      reason: 'trend is flat, stop outside noise',
    });
    expect(signals.get(id)?.events.map((event) => event.status)).toEqual([
      'queued',
      'failed',
      'failed',
      'processed',
    ]);
  });

  it('keeps both legs out while the quote read errors, without calling the LLM again', async () => {
    const fixtures = await writeFixtures();
    const quotes = quotesAt();
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION), {
      quotes,
    });
    post(signals, {});

    for (const offset of [0, 30_000, 60_000]) {
      const pass = await root.processSignals(signals, new Date(IN_SESSION.getTime() + offset));
      expect(pass).toMatchObject({ outcomes: [{ status: 'failed', detail: 'no quote' }] });
    }

    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_orders').get()).toEqual({ n: 0 });
  });

  it('a veto stays a veto across retries, though the model would now pass it', async () => {
    const fixtures = await writeFixtures();
    let replies = 0;
    const script: Script = () => {
      replies += 1;
      return replies === 1
        ? '{"veto": true, "reason": "stop sits inside daily noise"}'
        : '{"veto": false, "reason": "fine now"}';
    };
    const quotes = quotesAt(STALE, FRESH);
    const { root, signals, transports } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      { quotes },
      script,
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    await root.processSignals(signals, new Date(IN_SESSION.getTime() + 30_000));

    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toMatchObject({ outcome: 'simulated' });
    expect(
      root.db
        .prepare("SELECT action, reason FROM v2_decisions WHERE book_id = 'signals/primary'")
        .get(),
    ).toEqual({ action: 'skip', reason: 'vetoed: veto: stop sits inside daily noise' });
    expect(signals.get(id)?.events.at(-1)?.detail).toMatch(
      /^veto veto: stop sits inside daily noise;/,
    );
    expect(signals.vetoVerdicts(20)).toEqual(['veto']);
  });

  it('a restarted process reuses the verdict journalled before the crash', async () => {
    const fixtures = await writeFixtures();
    const before = open(fixtures, new SimulatedClock(IN_SESSION), { quotes: quotesAt(STALE) });
    const id = post(before.signals, {});
    await before.root.processSignals(before.signals, IN_SESSION);
    roots.splice(roots.indexOf(before.root), 1);
    before.root.close();

    const after = open(fixtures, new SimulatedClock(IN_SESSION), { quotes: quotesAt(FRESH) });
    const entered = await after.root.processSignals(
      after.signals,
      new Date(IN_SESSION.getTime() + 30_000),
    );

    expect(entered).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(before.transports.flatMap((transport) => transport.calls)).toHaveLength(1);
    expect(after.transports.flatMap((transport) => transport.calls)).toHaveLength(0);
    expect(after.root.journal.orderFor(shadowId(id))).toBeDefined();
  });

  it('a signal entered after retries journals the same decisions as one entered at once', async () => {
    const clean = await writeFixtures();
    const once = open(clean, new SimulatedClock(IN_SESSION), { quotes: quotesAt(FRESH) });
    const onceId = post(once.signals, {});
    await once.root.processSignals(once.signals, new Date(IN_SESSION.getTime() + 30_000));

    const retried = await writeFixtures();
    const twice = open(retried, new SimulatedClock(IN_SESSION), {
      quotes: quotesAt(STALE, FRESH),
    });
    const twiceId = post(twice.signals, {});
    await twice.root.processSignals(twice.signals, IN_SESSION);
    await twice.root.processSignals(twice.signals, new Date(IN_SESSION.getTime() + 30_000));

    const decisions = decisionRows(once.root, onceId);
    expect(decisions).toHaveLength(2);
    expect(decisionRows(twice.root, twiceId)).toEqual(decisions);
  });
});

describe('a failed veto call gets one more attempt (David 2026-10-09, #2024)', () => {
  const LATER = new Date(IN_SESSION.getTime() + 30_000);
  const LATEST = new Date(IN_SESSION.getTime() + 60_000);

  function failingThen(...replies: readonly (string | Error)[]): Script {
    let calls = 0;
    return () => {
      const reply = replies[Math.min(calls, replies.length - 1)] as string | Error;
      calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    };
  }

  const PASS = '{"veto": false, "reason": "trend is flat, stop outside noise"}';
  const FAIL = new Error('upstream 503');

  function callsOf(transports: readonly ScriptedTransport[]): number {
    return transports.flatMap((transport) => transport.calls).length;
  }

  function primaryDecision(root: V2Root) {
    return root.db
      .prepare("SELECT action, reason FROM v2_decisions WHERE book_id = 'signals/primary'")
      .get();
  }

  function decisionRows(root: V2Root, signalId: string): readonly string[] {
    const rows = root.db
      .prepare(
        `SELECT book_id, trading_date, instrument, action, reason, payload
         FROM v2_decisions ORDER BY book_id`,
      )
      .all();
    return rows.map((row) => JSON.stringify(row).replaceAll(signalId, '<signal>'));
  }

  function spendTheCap(storePath: string): void {
    const db = openSharedStore(storePath);
    try {
      db.prepare(
        `INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp)
         VALUES ('t', 'debate', 'm', 1, 1, 1000, 1, '${D}T00:00:00.000Z')`,
      ).run();
    } finally {
      db.close();
    }
  }

  it('a call failure then a pass makes exactly 2 calls, and the primary enters', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      {},
      failingThen(FAIL, PASS),
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    const retried = await root.processSignals(signals, LATER);

    expect(retried).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(transports)).toBe(2);
    expect(root.journal.orderFor(primaryId(id))).toBeDefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
    expect(signals.vetoFor(id)).toEqual({
      kind: 'unavailable',
      reason: 'llm_call_failed: upstream 503',
    });
    expect(signals.vetoRetry(id)).toEqual({
      claimed: true,
      veto: { kind: 'pass', reason: 'trend is flat, stop outside noise' },
    });
    expect(signals.get(id)?.events.map((event) => event.status)).toEqual([
      'queued',
      'failed',
      'processed',
    ]);
  });

  it('a second failure is final: the primary stays out, the shadow enters, exactly 2 calls', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      {},
      failingThen(FAIL, FAIL, PASS),
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    const retried = await root.processSignals(signals, LATER);

    expect(retried).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(transports)).toBe(2);
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
    expect(primaryDecision(root)).toEqual({
      action: 'skip',
      reason: 'vetoed: unavailable: llm_call_failed: upstream 503',
    });
    expect(await root.processSignals(signals, LATEST)).toMatchObject({ ran: false });
    expect(callsOf(transports)).toBe(2);
  });

  it('a spend-cap refusal on the first attempt makes no call and is final at once', async () => {
    const fixtures = await writeFixtures();
    spendTheCap(fixtures.storePath);
    const { root, signals, transports } = open(fixtures, new SimulatedClock(IN_SESSION));
    const id = post(signals, {});

    const pass = await root.processSignals(signals, IN_SESSION);

    expect(pass).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(transports)).toBe(0);
    expect(signals.vetoRetry(id)).toEqual({ claimed: false, veto: undefined });
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
  });

  it('a spend-cap refusal on the retry leaves exactly 1 call and is final', async () => {
    const fixtures = await writeFixtures();
    const { root, signals, transports } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      {},
      failingThen(FAIL, PASS),
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    spendTheCap(fixtures.storePath);
    const capped = await root.processSignals(signals, LATER);

    expect(capped).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(transports)).toBe(1);
    expect(signals.vetoRetry(id).veto).toEqual({
      kind: 'unavailable',
      reason: 'llm_spend_cap:budget',
    });
    expect(root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(root.journal.orderFor(shadowId(id))).toBeDefined();
    expect(primaryDecision(root)).toEqual({
      action: 'skip',
      reason: 'vetoed: unavailable: llm_spend_cap:budget',
    });
  });

  it('a restart after the retry journalled its verdict makes no third call', async () => {
    const fixtures = await writeFixtures();
    const STALE = quote(25, new Date(IN_SESSION.getTime() - 1));
    const before = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      { quotes: quotesAt(STALE) },
      failingThen(FAIL, PASS),
    );
    const id = post(before.signals, {});
    await before.root.processSignals(before.signals, IN_SESSION);
    await before.root.processSignals(before.signals, LATER);
    roots.splice(roots.indexOf(before.root), 1);
    before.root.close();

    const after = open(fixtures, new SimulatedClock(IN_SESSION), { quotes: quotesAt(quote(25)) });
    const entered = await after.root.processSignals(after.signals, LATEST);

    expect(entered).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(before.transports)).toBe(2);
    expect(callsOf(after.transports)).toBe(0);
    expect(after.root.journal.orderFor(primaryId(id))).toBeDefined();
  });

  it('a restart during the retry call makes no third call: the retry is unavailable and final', async () => {
    const fixtures = await writeFixtures();
    const before = open(fixtures, new SimulatedClock(IN_SESSION), {}, failingThen(FAIL));
    const id = post(before.signals, {});
    await before.root.processSignals(before.signals, IN_SESSION);
    before.signals.claimVetoRetry(id);
    roots.splice(roots.indexOf(before.root), 1);
    before.root.close();

    const after = open(fixtures, new SimulatedClock(IN_SESSION));
    const pass = await after.root.processSignals(after.signals, LATER);

    expect(pass).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(callsOf(before.transports)).toBe(1);
    expect(callsOf(after.transports)).toBe(0);
    expect(after.signals.vetoRetry(id).veto).toEqual({
      kind: 'unavailable',
      reason: 'llm_call_failed: the retry was interrupted before its verdict was journalled',
    });
    expect(after.root.journal.orderFor(primaryId(id))).toBeUndefined();
    expect(after.root.journal.orderFor(shadowId(id))).toBeDefined();
  });

  it('a signal entered after a retried veto journals the same decisions as one passed at once', async () => {
    const clean = await writeFixtures();
    const once = open(clean, new SimulatedClock(IN_SESSION));
    const onceId = post(once.signals, {});
    await once.root.processSignals(once.signals, LATER);

    const retried = await writeFixtures();
    const twice = open(retried, new SimulatedClock(IN_SESSION), {}, failingThen(FAIL, PASS));
    const twiceId = post(twice.signals, {});
    await twice.root.processSignals(twice.signals, IN_SESSION);
    await twice.root.processSignals(twice.signals, LATER);

    const decisions = decisionRows(once.root, onceId);
    expect(decisions).toHaveLength(2);
    expect(decisionRows(twice.root, twiceId)).toEqual(decisions);
  });

  it('a retried veto that fails twice journals the same decisions on every later pass', async () => {
    const fixtures = await writeFixtures();
    const { root, signals } = open(
      fixtures,
      new SimulatedClock(IN_SESSION),
      { quotes: quotesAt(quote(25, new Date(IN_SESSION.getTime() - 1)), quote(25)) },
      failingThen(FAIL),
    );
    const id = post(signals, {});

    await root.processSignals(signals, IN_SESSION);
    await root.processSignals(signals, LATER);
    const entered = await root.processSignals(signals, LATEST);

    expect(entered).toMatchObject({ outcomes: [{ status: 'processed' }] });
    expect(signals.vetoRetry(id).veto).toEqual({
      kind: 'unavailable',
      reason: 'llm_call_failed: upstream 503',
    });
    expect(decisionRows(root, id)).toHaveLength(2);
    expect(primaryDecision(root)).toEqual({
      action: 'skip',
      reason: 'vetoed: unavailable: llm_call_failed: upstream 503',
    });
  });
});
