import type { Bar } from '../providers/market-data-service/index.js';
import { closeTimeOf, computeIndicator } from '../providers/market-data-service/index.js';
import { median, TokenBucket } from '../shared/index.js';
import type { DateRange } from './backtest/index.js';
import {
  DEFAULT_STAGE2_TIMEFRAME,
  FreeStackAggregatesClient,
  HttpPolygonClient,
  Stage2HistoricalStore,
} from './backtest/index.js';
import { CRYPTO_SYMBOLS, STOCK_SYMBOLS } from './run-stage2.js';
import { STAGE2_FREE_STACK_WINDOW } from './stage2-source.js';

const ATR_WINDOW = 14;

export const CALIBRATION_WINDOW: DateRange = {
  start: new Date('2024-08-06T00:00:00.000Z'),
  end: new Date('2026-08-05T00:00:00.000Z'),
};

const DEFAULT_SAMPLE_DAYS = 24;

const SAMPLE_MINUTES = 5;

const QUOTE_LIMIT = 500;

interface AlpacaQuote {
  ap: number;
  bp: number;
  t: string;
}

interface SymbolSpreadStats {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
  days_sampled: number;
  quotes_sampled: number;
  days_with_atr: number;
  median_spread: number;
  median_spread_bps: number;
  p90_spread_bps: number;
  median_spread_over_atr: number;
  p90_spread_over_atr: number;
}

interface SpreadCalibration {
  symbols: SymbolSpreadStats[];
  fitted: { stocks: number; crypto: number };
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] as number;
}

export function usEquityCloseUtc(date: Date): Date {
  const offsetHours = easternOffsetHours(date);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 16 + offsetHours, 0, 0),
  );
}

function easternOffsetHours(date: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(date);
  return formatted.includes('EDT') ? 4 : 5;
}

export function sampleDates(window: DateRange, count: number): Date[] {
  const span = window.end.getTime() - window.start.getTime();
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(window.start.getTime() + (span * (i + 0.5)) / count);
    dates.push(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())));
  }
  return dates;
}

export interface QuoteSource {
  stockQuotes(symbol: string, start: Date, end: Date): Promise<AlpacaQuote[]>;
  cryptoQuotes(symbol: string, start: Date, end: Date): Promise<AlpacaQuote[]>;
}

class AlpacaQuoteClient implements QuoteSource {
  constructor(
    private readonly keyId: string,
    private readonly secret: string,
    private readonly bucket = new TokenBucket({ capacity: 10, refillPerSecond: 2 }),
  ) {}

  private async get(url: string): Promise<unknown> {
    await this.bucket.acquire();
    const response = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secret },
    });
    if (!response.ok) {
      throw new Error(`Alpaca quotes ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  async stockQuotes(symbol: string, start: Date, end: Date): Promise<AlpacaQuote[]> {
    const body = (await this.get(
      `https://data.alpaca.markets/v2/stocks/${symbol}/quotes` +
        `?start=${start.toISOString()}&end=${end.toISOString()}&limit=${QUOTE_LIMIT}`,
    )) as { quotes?: AlpacaQuote[] | null };
    return body.quotes ?? [];
  }

  async cryptoQuotes(symbol: string, start: Date, end: Date): Promise<AlpacaQuote[]> {
    const pair = symbol.replace('-', '/');
    const body = (await this.get(
      `https://data.alpaca.markets/v1beta3/crypto/us/quotes?symbols=${encodeURIComponent(pair)}` +
        `&start=${start.toISOString()}&end=${end.toISOString()}&limit=${QUOTE_LIMIT}`,
    )) as { quotes?: Record<string, AlpacaQuote[]> | null };
    return body.quotes?.[pair] ?? [];
  }
}

function spreadOf(quote: AlpacaQuote): number | undefined {
  if (!(quote.ap > 0) || !(quote.bp > 0)) return undefined;
  const spread = quote.ap - quote.bp;
  return spread > 0 ? spread : undefined;
}

function medianSpreadAndMid(
  page: readonly AlpacaQuote[],
): { spread: number; mid: number; quoteCount: number } | undefined {
  const spreads = page.map(spreadOf).filter((s): s is number => s !== undefined);
  if (spreads.length === 0) return undefined;
  const mids = page.filter((q) => q.ap > 0 && q.bp > 0).map((q) => (q.ap + q.bp) / 2);
  return { spread: median(spreads), mid: median(mids), quoteCount: spreads.length };
}

function atrAt(bars: readonly Bar[], at: Date, timeframe: string): number | undefined {
  const upTo = bars.filter((bar) => bar.close_time.getTime() <= at.getTime());
  if (upTo.length < ATR_WINDOW + 1) return undefined;
  const value = computeIndicator(upTo.slice(-(ATR_WINDOW + 1)) as Bar[], {
    indicator: 'atr',
    params: {},
    timeframe,
    lookback: ATR_WINDOW,
  });
  return value > 0 ? value : undefined;
}

type BarStore = Pick<Stage2HistoricalStore, 'ingest' | 'bars'>;
type AggregatesSource = Pick<FreeStackAggregatesClient, 'fetchAggregates'>;

export interface SpreadCalibrationDeps {
  window?: DateRange;
  sampleDays?: number;
  dbPath?: string;
  print?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  store?: BarStore;
  quotes?: QuoteSource;
}

function alpacaCredentials(
  env: NodeJS.ProcessEnv,
  caller: string,
): { keyId: string; secret: string } {
  const keyId = env.ALPACA_API_KEY;
  const secret = env.ALPACA_API_SECRET;
  if (keyId === undefined || secret === undefined) {
    throw new Error(`${caller}: ALPACA_API_KEY and ALPACA_API_SECRET are required.`);
  }
  return { keyId, secret };
}

async function ingestSymbolBars(
  store: BarStore,
  symbols: readonly string[],
  window: DateRange,
): Promise<Map<string, Bar[]>> {
  const bars = new Map<string, Bar[]>();
  for (const symbol of symbols) {
    await store.ingest(symbol, window);
    bars.set(symbol, store.bars(symbol, window));
  }
  return bars;
}

interface DateSpreadSample {
  end: Date;
  quoteCount: number;
  daySpread: number;
  dayBps: number | undefined;
}

async function sampleDateSpread(
  symbol: string,
  isCrypto: boolean,
  date: Date,
  quotes: QuoteSource,
  print: (line: string) => void,
): Promise<DateSpreadSample | undefined> {
  const end = isCrypto
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59))
    : usEquityCloseUtc(date);
  const start = new Date(end.getTime() - SAMPLE_MINUTES * 60_000);

  let page: AlpacaQuote[];
  try {
    page = isCrypto
      ? await quotes.cryptoQuotes(symbol, start, end)
      : await quotes.stockQuotes(symbol, start, end);
  } catch (error) {
    print(`  ${symbol} ${date.toISOString().slice(0, 10)}: ${String(error)}`);
    return undefined;
  }

  const sample = medianSpreadAndMid(page);
  if (sample === undefined) return undefined;
  const { spread: daySpread, mid: dayMid, quoteCount } = sample;

  return {
    end,
    quoteCount,
    daySpread,
    dayBps: dayMid > 0 ? (daySpread / dayMid) * 10_000 : undefined,
  };
}

async function sampleSymbolSpreads(
  symbol: string,
  isCrypto: boolean,
  dates: readonly Date[],
  symbolBars: Bar[],
  quotes: QuoteSource,
  print: (line: string) => void,
): Promise<SymbolSpreadStats> {
  const dailySpreads: number[] = [];
  const dailyBps: number[] = [];
  const dailyRatios: number[] = [];
  let quotesSampled = 0;

  for (const date of dates) {
    const sample = await sampleDateSpread(symbol, isCrypto, date, quotes, print);
    if (sample === undefined) continue;

    quotesSampled += sample.quoteCount;
    dailySpreads.push(sample.daySpread);
    if (sample.dayBps !== undefined) dailyBps.push(sample.dayBps);

    const atr = atrAt(symbolBars, sample.end, DEFAULT_STAGE2_TIMEFRAME);
    if (atr !== undefined) dailyRatios.push(sample.daySpread / atr);
  }

  return {
    symbol,
    asset_class: isCrypto ? 'crypto' : 'stocks',
    days_sampled: dailySpreads.length,
    quotes_sampled: quotesSampled,
    days_with_atr: dailyRatios.length,
    median_spread: median(dailySpreads),
    median_spread_bps: median(dailyBps),
    p90_spread_bps: percentile(dailyBps, 0.9),
    median_spread_over_atr: median(dailyRatios),
    p90_spread_over_atr: percentile(dailyRatios, 0.9),
  };
}

function fitCoefficientFor(
  symbols: readonly SymbolSpreadStats[],
  assetClass: 'crypto' | 'stocks',
): number {
  return median(
    symbols
      .filter((s) => s.asset_class === assetClass && Number.isFinite(s.median_spread_over_atr))
      .map((s) => s.median_spread_over_atr),
  );
}

function printSpreadTable(
  symbols: readonly SymbolSpreadStats[],
  print: (line: string) => void,
): void {
  print('');
  print('=== Measured spread, at the bar close ===');
  for (const s of symbols) {
    print(
      `[${s.asset_class}] ${s.symbol.padEnd(8)} days=${s.days_sampled} (atr=${s.days_with_atr}) quotes=${s.quotes_sampled} ` +
        `median=${s.median_spread_bps.toFixed(2)}bps p90=${s.p90_spread_bps.toFixed(2)}bps ` +
        `spread/ATR median=${s.median_spread_over_atr.toFixed(4)} p90=${s.p90_spread_over_atr.toFixed(4)}`,
    );
  }
}

function printFittedCoefficients(
  fitted: SpreadCalibration['fitted'],
  print: (line: string) => void,
): void {
  print('');
  print('=== Fitted spreadVolatilityCoefficient (from medians) ===');
  print(`  stocks: ${fitted.stocks.toFixed(4)}   (fixture: 0.1)`);
  print(`  crypto: ${fitted.crypto.toFixed(4)}   (fixture: 0.5)`);
}

export async function runSpreadCalibration(
  deps: SpreadCalibrationDeps = {},
): Promise<SpreadCalibration> {
  const print = deps.print ?? console.log;
  const window = deps.window ?? CALIBRATION_WINDOW;
  const { keyId, secret } = alpacaCredentials(deps.env ?? process.env, 'runSpreadCalibration');

  const store =
    deps.store ??
    new Stage2HistoricalStore(new HttpPolygonClient(), {
      timeframe: DEFAULT_STAGE2_TIMEFRAME,
      dbPath: deps.dbPath ?? 'stage2-cost-decomposition.sqlite',
    });
  const quotes = deps.quotes ?? new AlpacaQuoteClient(keyId, secret);

  const allSymbols = [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS];
  const bars = await ingestSymbolBars(store, allSymbols, window);

  const dates = sampleDates(window, deps.sampleDays ?? DEFAULT_SAMPLE_DAYS);
  print(
    `Sampling ${dates.length} dates across ${window.start.toISOString().slice(0, 10)} .. ${window.end.toISOString().slice(0, 10)}`,
  );

  const symbols: SymbolSpreadStats[] = [];

  for (const symbol of allSymbols) {
    const isCrypto = (CRYPTO_SYMBOLS as readonly string[]).includes(symbol);
    const symbolBars = bars.get(symbol) ?? [];
    symbols.push(await sampleSymbolSpreads(symbol, isCrypto, dates, symbolBars, quotes, print));
  }

  const calibration: SpreadCalibration = {
    symbols,
    fitted: {
      stocks: fitCoefficientFor(symbols, 'stocks'),
      crypto: fitCoefficientFor(symbols, 'crypto'),
    },
  };

  printSpreadTable(symbols, print);
  printFittedCoefficients(calibration.fitted, print);

  return calibration;
}

const INTRADAY_CALIBRATION_TIMEFRAME = '1m';

export const INTRADAY_CALIBRATION_WINDOW: DateRange = STAGE2_FREE_STACK_WINDOW;

export const SESSION_BUCKETS = [
  { name: 'open', minutesAfterOpen: 10 },
  { name: 'midday', minutesAfterOpen: 195 },
  { name: 'close', minutesAfterOpen: 385 },
] as const;

type SessionBucketName = (typeof SESSION_BUCKETS)[number]['name'];

const SESSION_MINUTES = 390;

export function usEquityOpenUtc(date: Date): Date {
  return new Date(usEquityCloseUtc(date).getTime() - SESSION_MINUTES * 60_000);
}

export function bucketSampleEnd(date: Date, minutesAfterOpen: number): Date {
  return new Date(usEquityOpenUtc(date).getTime() + minutesAfterOpen * 60_000);
}

interface IntradayBucketStats {
  bucket: SessionBucketName;
  samples: number;
  quotes_sampled: number;
  median_spread_bps: number;
  median_spread_over_atr: number;
  p90_spread_over_atr: number;
}

interface IntradaySymbolStats {
  symbol: string;
  buckets: IntradayBucketStats[];
  median_spread_bps: number;
  p90_spread_bps: number;
  median_spread_over_atr: number;
  p90_spread_over_atr: number;
  samples: number;
}

interface IntradaySpreadCalibration {
  timeframe: string;
  symbols: IntradaySymbolStats[];
  fitted_stocks: number;
  p90_stocks: number;
}

export interface IntradaySpreadCalibrationDeps {
  window?: DateRange;
  sampleDays?: number;
  print?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  bars?: AggregatesSource;
  quotes?: QuoteSource;
}

async function sessionBars(
  client: AggregatesSource,
  symbol: string,
  window: DateRange,
): Promise<Bar[]> {
  const aggregates = await client.fetchAggregates(symbol, window, INTRADAY_CALIBRATION_TIMEFRAME);
  return aggregates
    .map((aggregate) => {
      const openTime = new Date(aggregate.t);
      return {
        instrument: symbol,
        source: 'alpaca',
        timeframe: INTRADAY_CALIBRATION_TIMEFRAME,
        open_time: openTime,
        close_time: closeTimeOf(openTime, INTRADAY_CALIBRATION_TIMEFRAME),
        open: aggregate.o,
        high: aggregate.h,
        low: aggregate.l,
        close: aggregate.c,
        volume: aggregate.v,
      } satisfies Bar;
    })
    .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());
}

type SessionBucketCell = { ratios: number[]; bps: number[]; quotes: number };

interface BucketSpreadSample {
  quoteCount: number;
  bps: number | undefined;
  ratio: number | undefined;
}

async function sampleBucketSpread(
  symbol: string,
  date: Date,
  bucket: (typeof SESSION_BUCKETS)[number],
  minuteBars: Bar[],
  quotes: QuoteSource,
  print: (line: string) => void,
): Promise<BucketSpreadSample | undefined> {
  const end = bucketSampleEnd(date, bucket.minutesAfterOpen);
  const start = new Date(end.getTime() - 60_000);
  let page: AlpacaQuote[];
  try {
    page = await quotes.stockQuotes(symbol, start, end);
  } catch (error) {
    print(`  ${symbol} ${end.toISOString()}: ${String(error)}`);
    return undefined;
  }
  const sample = medianSpreadAndMid(page);
  if (sample === undefined) return undefined;
  const { spread, mid, quoteCount } = sample;
  const atr = atrAt(minuteBars, end, INTRADAY_CALIBRATION_TIMEFRAME);
  return {
    quoteCount,
    bps: mid > 0 ? (spread / mid) * 10_000 : undefined,
    ratio: atr !== undefined ? spread / atr : undefined,
  };
}

async function sampleSessionForDate(
  symbol: string,
  date: Date,
  perBucket: Map<SessionBucketName, SessionBucketCell>,
  bars: AggregatesSource,
  quotes: QuoteSource,
  print: (line: string) => void,
): Promise<void> {
  const sessionOpen = usEquityOpenUtc(date);
  const sessionWindow: DateRange = {
    start: new Date(sessionOpen.getTime() - 60 * 60_000),
    end: usEquityCloseUtc(date),
  };
  let minuteBars: Bar[];
  try {
    minuteBars = await sessionBars(bars, symbol, sessionWindow);
  } catch (error) {
    print(`  ${symbol} ${date.toISOString().slice(0, 10)} bars: ${String(error)}`);
    return;
  }
  if (minuteBars.length === 0) return;

  for (const bucket of SESSION_BUCKETS) {
    const sample = await sampleBucketSpread(symbol, date, bucket, minuteBars, quotes, print);
    const cell = perBucket.get(bucket.name);
    if (cell === undefined || sample === undefined) continue;
    cell.quotes += sample.quoteCount;
    if (sample.bps !== undefined) cell.bps.push(sample.bps);
    if (sample.ratio !== undefined) cell.ratios.push(sample.ratio);
  }
}

function buildBucketStats(
  perBucket: Map<SessionBucketName, SessionBucketCell>,
): IntradayBucketStats[] {
  return SESSION_BUCKETS.map((b) => {
    const cell = perBucket.get(b.name) ?? { ratios: [], bps: [], quotes: 0 };
    return {
      bucket: b.name,
      samples: cell.ratios.length,
      quotes_sampled: cell.quotes,
      median_spread_bps: median(cell.bps),
      median_spread_over_atr: median(cell.ratios),
      p90_spread_over_atr: percentile(cell.ratios, 0.9),
    };
  });
}

function buildIntradaySymbolStats(
  symbol: string,
  perBucket: Map<SessionBucketName, SessionBucketCell>,
): IntradaySymbolStats {
  const buckets = buildBucketStats(perBucket);

  const pooledRatios = buckets.flatMap((b) => {
    const cell = perBucket.get(b.bucket);
    return cell === undefined ? [] : cell.ratios;
  });
  const pooledBps = buckets.flatMap((b) => {
    const cell = perBucket.get(b.bucket);
    return cell === undefined ? [] : cell.bps;
  });

  return {
    symbol,
    buckets,
    samples: pooledRatios.length,
    median_spread_bps: median(pooledBps),
    p90_spread_bps: percentile(pooledBps, 0.9),
    median_spread_over_atr: median(pooledRatios),
    p90_spread_over_atr: percentile(pooledRatios, 0.9),
  };
}

function buildIntradayCalibration(symbols: IntradaySymbolStats[]): IntradaySpreadCalibration {
  const perSymbol = symbols
    .map((s) => s.median_spread_over_atr)
    .filter((value) => Number.isFinite(value));
  return {
    timeframe: INTRADAY_CALIBRATION_TIMEFRAME,
    symbols,
    fitted_stocks: median(perSymbol),
    p90_stocks: percentile(perSymbol, 0.9),
  };
}

function printIntradayTable(
  symbols: readonly IntradaySymbolStats[],
  print: (line: string) => void,
): void {
  print('');
  print(`=== Measured spread vs ATR14 on ${INTRADAY_CALIBRATION_TIMEFRAME} bars ===`);
  for (const s of symbols) {
    print(
      `${s.symbol.padEnd(6)} n=${s.samples} median=${s.median_spread_bps.toFixed(3)}bps ` +
        `p90=${s.p90_spread_bps.toFixed(3)}bps spread/ATR median=${s.median_spread_over_atr.toFixed(4)} ` +
        `p90=${s.p90_spread_over_atr.toFixed(4)}`,
    );
    for (const b of s.buckets) {
      print(
        `  ${b.bucket.padEnd(7)} n=${b.samples} quotes=${b.quotes_sampled} ` +
          `median=${b.median_spread_bps.toFixed(3)}bps spread/ATR median=${b.median_spread_over_atr.toFixed(4)} ` +
          `p90=${b.p90_spread_over_atr.toFixed(4)}`,
      );
    }
  }
}

function printIntradayFitted(
  calibration: IntradaySpreadCalibration,
  print: (line: string) => void,
): void {
  print('');
  print('=== Fitted intraday spreadVolatilityCoefficient (stocks, from medians) ===');
  print(
    `  stocks: ${calibration.fitted_stocks.toFixed(4)}   ` +
      `(p90 across symbols: ${calibration.p90_stocks.toFixed(4)}; daily-fitted: 0.0037)`,
  );
}

export async function runIntradaySpreadCalibration(
  deps: IntradaySpreadCalibrationDeps = {},
): Promise<IntradaySpreadCalibration> {
  const print = deps.print ?? console.log;
  const window = deps.window ?? INTRADAY_CALIBRATION_WINDOW;
  const { keyId, secret } = alpacaCredentials(
    deps.env ?? process.env,
    'runIntradaySpreadCalibration',
  );

  const bars =
    deps.bars ?? new FreeStackAggregatesClient({ alpacaKeyId: keyId, alpacaSecretKey: secret });
  const quotes = deps.quotes ?? new AlpacaQuoteClient(keyId, secret);

  const dates = sampleDates(window, deps.sampleDays ?? DEFAULT_SAMPLE_DAYS);
  print(
    `Intraday: sampling ${dates.length} dates x ${SESSION_BUCKETS.length} session buckets across ` +
      `${window.start.toISOString().slice(0, 10)} .. ${window.end.toISOString().slice(0, 10)} ` +
      `at ${INTRADAY_CALIBRATION_TIMEFRAME}`,
  );

  const symbols: IntradaySymbolStats[] = [];

  for (const symbol of STOCK_SYMBOLS) {
    const perBucket = new Map<SessionBucketName, SessionBucketCell>(
      SESSION_BUCKETS.map((b) => [b.name, { ratios: [], bps: [], quotes: 0 }]),
    );

    for (const date of dates) {
      await sampleSessionForDate(symbol, date, perBucket, bars, quotes, print);
    }

    symbols.push(buildIntradaySymbolStats(symbol, perBucket));
  }

  const calibration = buildIntradayCalibration(symbols);

  printIntradayTable(symbols, print);
  printIntradayFitted(calibration, print);

  return calibration;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv.includes('--intraday')
    ? runIntradaySpreadCalibration()
    : runSpreadCalibration();
  run.catch((error: unknown) => {
    console.error('Spread calibration failed:', error);
    process.exitCode = 1;
  });
}
