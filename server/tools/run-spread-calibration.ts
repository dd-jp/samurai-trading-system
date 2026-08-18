/**
 * Measures the real bid/ask spread the MVP universe actually quotes, and fits
 * `CostConfig.spreadVolatilityCoefficient` to it.
 *
 * ## Why this exists
 *
 * `PESSIMISTIC_COST_CONFIG` was never a calibration — `run-stage2.ts` says so
 * outright ("mirrors `cost-model.test.ts`'s `PESSIMISTIC_CONFIG` fixture, the
 * only asset-class cost values this repo has settled on so far"). The
 * gross-vs-net decomposition (#403) showed what that costs: the fixture charges
 * crypto 211bps per round trip — an adverse move of 0.45 ATR on every fill,
 * against a strategy whose targets sit at 3-4 ATR — and single-handedly turned
 * the Stage 2 verdict into a KILL. Spread and slippage were 95% of that charge.
 *
 * The charge is large because `ReplayDriver.marketState()` hardcodes
 * `spread: null` (historical daily bars carry no bid/ask), so the cost model's
 * fallback fires on EVERY fill: `spread = volatility × spreadVolatilityCoefficient`,
 * with `volatility` the same ATR the strategy sized its stop from. At the
 * fixture's `0.5` that is a quarter of an ATR in half-spread alone.
 *
 * So the coefficient is the number to fit, and it is fittable from data: sample
 * the real quoted spread, divide by the ATR the cost model would have seen, and
 * take the ratio. That replaces a guess with a measurement while keeping the
 * model's shape untouched.
 *
 * ## Point-in-time discipline
 *
 * The replay fills at the bar close (`ReplayDriver.openLot` prices against
 * `bar.close`). So the spread that matters is the spread AT the close, not a
 * convenient midday snapshot — SPY quotes ~0.18bps mid-session and materially
 * wider into the close. Stocks are therefore sampled in the last minutes of the
 * regular session, and crypto at the same UTC day boundary its daily bars close
 * on.
 *
 * The sampling window deliberately STOPS before the closing bell rather than
 * spanning it. A quote timestamped exactly at the close is a closing-auction
 * artifact, not a tradeable two-sided market: a live probe on 2026-08-05 at
 * 20:00:00.008Z returned SPY at 752.40/799.00, a 6% spread. Including those
 * would calibrate the model to an artifact.
 *
 * ## What is reported
 *
 * Median AND p90, per symbol, with the sample size. Spreads are right-skewed —
 * a mean over a window containing a volatility spike is not the typical fill —
 * so the coefficient is fit from the median, and a large median/p90 divergence
 * is itself a finding about whether one coefficient can represent this market
 * at all.
 *
 * Usage: `ALPACA_API_KEY=... ALPACA_API_SECRET=... POLYGON_API_KEY=... \
 *   node dist/server/tools/run-spread-calibration.js`
 */

import type { Bar } from '../providers/market-data-service/index.js';
import { computeIndicator } from '../providers/market-data-service/index.js';
import { TokenBucket } from '../shared/http/token-bucket.js';
import type { DateRange } from './backtest/index.js';
import {
  DEFAULT_STAGE2_TIMEFRAME,
  HttpPolygonClient,
  Stage2HistoricalStore,
} from './backtest/index.js';
import { CRYPTO_SYMBOLS, STOCK_SYMBOLS } from './run-stage2.js';

/** The ATR window the grid holds fixed, and therefore the one the cost model sees. */
const ATR_WINDOW = 14;

/**
 * The window the Stage 2 grid was actually replayed over.
 *
 * Deliberately the EFFECTIVE window, not `PINNED_VERDICT_WINDOW`'s requested
 * 5 years. Alpaca serves quotes well beyond what this Polygon plan serves bars
 * for (2 years — a paid entitlement cap, #403), so sampling the requested
 * window would measure spreads over five years while the ATR denominator only
 * exists for the last two. The ratio being fit is a ratio of two quantities
 * that must come from the same period, and the period that matters is the one
 * the grid was scored on.
 */
export const CALIBRATION_WINDOW: DateRange = {
  start: new Date('2024-08-06T00:00:00.000Z'),
  end: new Date('2026-08-05T00:00:00.000Z'),
};

/** How many trading days to sample across the window. */
const DEFAULT_SAMPLE_DAYS = 24;

/** Minutes before the close to sample. See "Point-in-time discipline". */
const SAMPLE_MINUTES = 5;

/** Alpaca caps a quotes page at 10k; a few hundred is ample for a median. */
const QUOTE_LIMIT = 500;

interface AlpacaQuote {
  ap: number;
  bp: number;
  t: string;
}

/** One symbol's fitted result. */
export interface SymbolSpreadStats {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
  days_sampled: number;
  quotes_sampled: number;
  /** Days where an ATR was also available, so a ratio could be formed. */
  days_with_atr: number;
  /** Median across days of (median quoted spread that day), in price units. */
  median_spread: number;
  median_spread_bps: number;
  p90_spread_bps: number;
  /** Median across days of (that day's spread / that day's ATR14). */
  median_spread_over_atr: number;
  p90_spread_over_atr: number;
}

export interface SpreadCalibration {
  symbols: SymbolSpreadStats[];
  /** Fitted `spreadVolatilityCoefficient`, per asset class, from the medians. */
  fitted: { stocks: number; crypto: number };
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] as number;
}

/**
 * US equities close at 20:00Z under EDT and 21:00Z under EST. Derived from the
 * date rather than assumed, because the sample window spans two years and
 * therefore several DST transitions; sampling an EST date at 20:00Z would
 * measure an hour before the close, where spreads are tighter.
 *
 * `Date`'s own US-Eastern offset is used rather than a hand-rolled DST table:
 * `Intl` knows the transition dates, and a table would silently drift.
 */
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

/** Evenly-spaced calendar dates across `window`, oldest first. */
export function sampleDates(window: DateRange, count: number): Date[] {
  const span = window.end.getTime() - window.start.getTime();
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(window.start.getTime() + (span * (i + 0.5)) / count);
    dates.push(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())));
  }
  return dates;
}

class AlpacaQuoteClient {
  constructor(
    private readonly keyId: string,
    private readonly secret: string,
    // Alpaca's 200 req/min is per ACCOUNT and shared with every other caller
    // (#391), so this probe paces itself rather than racing the orchestrator.
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
    // Alpaca's crypto feed uses `BTC/USD` where the rest of this repo uses
    // `BTC-USD` (CLAUDE.md's universe notation).
    const pair = symbol.replace('-', '/');
    const body = (await this.get(
      `https://data.alpaca.markets/v1beta3/crypto/us/quotes?symbols=${encodeURIComponent(pair)}` +
        `&start=${start.toISOString()}&end=${end.toISOString()}&limit=${QUOTE_LIMIT}`,
    )) as { quotes?: Record<string, AlpacaQuote[]> | null };
    return body.quotes?.[pair] ?? [];
  }
}

/**
 * A quote is usable only if both sides are present and the spread is positive.
 *
 * Crossed or locked books (ask <= bid) appear in raw consolidated feeds and are
 * not tradeable prices; including them would drag the median toward zero and
 * flatter the calibration, which is the direction this whole exercise is
 * trying not to err in.
 */
function spreadOf(quote: AlpacaQuote): number | undefined {
  if (!(quote.ap > 0) || !(quote.bp > 0)) return undefined;
  const spread = quote.ap - quote.bp;
  return spread > 0 ? spread : undefined;
}

/** ATR14 as of the last bar at or before `at` — the value the cost model would have seen. */
function atrAt(bars: readonly Bar[], at: Date): number | undefined {
  const upTo = bars.filter((bar) => bar.close_time.getTime() <= at.getTime());
  if (upTo.length < ATR_WINDOW + 1) return undefined;
  const value = computeIndicator(upTo.slice(-(ATR_WINDOW + 1)) as Bar[], {
    indicator: 'atr',
    params: {},
    // Daily bars — this is the Stage 2 replay grid, ingested as daily
    // aggregates. Descriptive rather than selecting: `computeIndicator`
    // runs on a slice the caller already holds, so the field records
    // WHICH bars these are (#315).
    timeframe: '1d',
    lookback: ATR_WINDOW,
  });
  return value > 0 ? value : undefined;
}

export interface SpreadCalibrationDeps {
  window?: DateRange;
  sampleDays?: number;
  dbPath?: string;
  print?: (line: string) => void;
}

export async function runSpreadCalibration(
  deps: SpreadCalibrationDeps = {},
): Promise<SpreadCalibration> {
  const print = deps.print ?? console.log;
  const window = deps.window ?? CALIBRATION_WINDOW;
  const keyId = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (keyId === undefined || secret === undefined) {
    throw new Error('runSpreadCalibration: ALPACA_API_KEY and ALPACA_API_SECRET are required.');
  }

  // DAILY, stated explicitly (#664): this calibration fits spread against
  // ATR14 measured on DAILY bars, which is the whole basis of
  // `CALIBRATED_COST_CONFIG`. An intraday recalibration is separate work.
  const store = new Stage2HistoricalStore(new HttpPolygonClient(), {
    timeframe: DEFAULT_STAGE2_TIMEFRAME,
    dbPath: deps.dbPath ?? 'stage2-cost-decomposition.sqlite',
  });
  const quotes = new AlpacaQuoteClient(keyId, secret);

  const bars = new Map<string, Bar[]>();
  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
    await store.ingest(symbol, window);
    bars.set(symbol, store.bars(symbol, window));
  }

  const dates = sampleDates(window, deps.sampleDays ?? DEFAULT_SAMPLE_DAYS);
  print(
    `Sampling ${dates.length} dates across ${window.start.toISOString().slice(0, 10)} .. ${window.end.toISOString().slice(0, 10)}`,
  );

  const symbols: SymbolSpreadStats[] = [];

  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
    const isCrypto = (CRYPTO_SYMBOLS as readonly string[]).includes(symbol);
    const symbolBars = bars.get(symbol) ?? [];
    const dailySpreads: number[] = [];
    const dailyBps: number[] = [];
    const dailyRatios: number[] = [];
    let quotesSampled = 0;

    for (const date of dates) {
      // Stocks: the last minutes of the regular session, stopping short of the
      // bell. Crypto: the same UTC day boundary its daily bars close on.
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
        continue;
      }

      const spreads = page.map(spreadOf).filter((s): s is number => s !== undefined);
      // An empty page is a market holiday or weekend, not an error — skip it
      // rather than recording a zero that would drag the median down.
      if (spreads.length === 0) continue;

      const mids = page.filter((q) => q.ap > 0 && q.bp > 0).map((q) => (q.ap + q.bp) / 2);
      const daySpread = median(spreads);
      const dayMid = median(mids);
      quotesSampled += spreads.length;
      dailySpreads.push(daySpread);
      if (dayMid > 0) dailyBps.push((daySpread / dayMid) * 10_000);

      const atr = atrAt(symbolBars, end);
      if (atr !== undefined) dailyRatios.push(daySpread / atr);
    }

    symbols.push({
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
    });
  }

  const fitFor = (assetClass: 'crypto' | 'stocks'): number =>
    median(
      symbols
        .filter((s) => s.asset_class === assetClass && Number.isFinite(s.median_spread_over_atr))
        .map((s) => s.median_spread_over_atr),
    );

  const calibration: SpreadCalibration = {
    symbols,
    fitted: { stocks: fitFor('stocks'), crypto: fitFor('crypto') },
  };

  print('');
  print('=== Measured spread, at the bar close ===');
  for (const s of symbols) {
    print(
      `[${s.asset_class}] ${s.symbol.padEnd(8)} days=${s.days_sampled} (atr=${s.days_with_atr}) quotes=${s.quotes_sampled} ` +
        `median=${s.median_spread_bps.toFixed(2)}bps p90=${s.p90_spread_bps.toFixed(2)}bps ` +
        `spread/ATR median=${s.median_spread_over_atr.toFixed(4)} p90=${s.p90_spread_over_atr.toFixed(4)}`,
    );
  }

  print('');
  print('=== Fitted spreadVolatilityCoefficient (from medians) ===');
  print(`  stocks: ${calibration.fitted.stocks.toFixed(4)}   (fixture: 0.1)`);
  print(`  crypto: ${calibration.fitted.crypto.toFixed(4)}   (fixture: 0.5)`);

  return calibration;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSpreadCalibration().catch((error: unknown) => {
    console.error('Spread calibration failed:', error);
    process.exitCode = 1;
  });
}
