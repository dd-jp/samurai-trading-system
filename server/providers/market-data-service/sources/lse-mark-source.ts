import { BOOK_CURRENCY, isBookCurrency, isPenceCurrency } from '../../../shared/index.js';
import type { RawCandle } from '../ingestion.js';
import { LseRegularHoursCalendar } from '../trading-calendar.js';
import type { Quote } from '../types.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

export { BOOK_CURRENCY, isBookCurrency };

export class MarkCurrencyError extends Error {
  readonly instrument: string;
  readonly currency: string;

  constructor(instrument: string, currency: string, vendor: string) {
    super(
      `${vendor} quoted ${instrument} in '${currency}', which cannot be served into a ` +
        `${BOOK_CURRENCY} book. Pence (GBX/GBp) are converted because that is an exact unit ` +
        'change; any other currency needs an FX rate this system does not source, and inventing ' +
        'one would put a systematically wrong mark on the live-money path while every health ' +
        'signal stayed green. Either trade the GBP-denominated line of this ETP, or resolve the ' +
        'FX decision (docs/research/34-lse-mark-source-options.md §3.2) before marking this row.',
    );
    this.name = 'MarkCurrencyError';
    this.instrument = instrument;
    this.currency = currency;
  }
}

export class NonTradeableInstrumentError extends Error {
  readonly instrument: string;

  constructor(instrument: string, tradeable: readonly string[], isScreeningInstrument: boolean) {
    super(
      isScreeningInstrument
        ? `LSE mark source refused '${instrument}': that is a SCREENING INSTRUMENT (the US ` +
            'underlying the screener ranks on), not an lse_ticker Samurai holds. Marking an LSE ' +
            '3x ETP off its US underlying is inadmissible — different leverage, different ' +
            'currency, and a session that overlaps by about two hours — so this substitution is ' +
            'refused at the source rather than warned about. Pass the lse_ticker (#734).'
        : `LSE mark source refused '${instrument}': it is not an lse_ticker in the LSE ETP pool ` +
            `(known: ${tradeable.join(', ') || 'none'}). There is no safe guess about which venue ` +
            'a symbol trades on, so there is no guess — add the row to lse-etp-pool.ts, or route ' +
            'this instrument to the source that actually serves its venue.',
    );
    this.name = 'NonTradeableInstrumentError';
    this.instrument = instrument;
  }
}

interface LseVendorCandle {
  open_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LseVendorBars {
  currency: string;
  candles: readonly LseVendorCandle[];
}

export interface LseVendorQuote {
  price: number;
  currency: string;
  observed_at: Date;
  bid?: number | undefined;
  ask?: number | undefined;
}

export interface LseMarkClient {
  readonly vendor: string;
  getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<LseVendorBars>;
  getLatestQuote(symbol: string): Promise<LseVendorQuote>;
}

export interface LseMarkSourceOptions {
  tradeable: ReadonlySet<string>;
  screeningInstruments?: ReadonlySet<string> | undefined;
  declaredCurrencies?: ReadonlyMap<string, string> | undefined;
  markTimeframe?: string | undefined;
}

export function toBookCurrency(
  price: number,
  currency: string,
  instrument: string,
  vendor: string,
): number {
  const code = currency.trim();
  if (isPenceCurrency(code)) {
    return price / 100;
  }
  if (code.toUpperCase() === BOOK_CURRENCY) {
    return price;
  }
  throw new MarkCurrencyError(instrument, currency, vendor);
}

function assertMarkableCurrencies(
  declared: ReadonlyMap<string, string> | undefined,
  vendor: string,
): void {
  if (declared === undefined) return;
  const offenders = [...declared]
    .filter(([, currency]) => !isBookCurrency(currency))
    .map(([instrument, currency]) => `${instrument} (${currency})`);
  if (offenders.length === 0) return;
  throw new Error(
    `LseMarkDataSource: cannot be constructed for ${offenders.join(', ')} — the pool declares ` +
      `${offenders.length === 1 ? 'this line' : 'these lines'} in a currency that is not ${BOOK_CURRENCY} ` +
      'or a pence sub-unit of it, and this system holds no FX rate. Marking them into a GBP book ' +
      'would require an FX decision nobody has made: see docs/research/34-lse-mark-source-options.md §3.2, ' +
      'which measured that most of the checked-in pool quotes in USD despite the GBP-only restriction ' +
      'ADR-0016/#659 asserts. #1220 narrowed the universe to the sterling lines — build the ' +
      'universe through tradeableUniverse() (universe-pool) and no such line can reach here. ' +
      `(vendor: ${vendor})`,
  );
}

export class LseMarkDataSource extends NormalizingDataSource {
  readonly #client: LseMarkClient;
  readonly #tradeable: ReadonlySet<string>;
  readonly #screeningInstruments: ReadonlySet<string>;
  readonly #markTimeframe: string;

  constructor(client: LseMarkClient, options: LseMarkSourceOptions) {
    super({
      source: client.vendor,
      asset_class: 'stocks',
      calendar: new LseRegularHoursCalendar(),
    });
    if (options.tradeable.size === 0) {
      throw new Error(
        'LseMarkDataSource: constructed with an empty tradeable set, so every read would be ' +
          'refused. An empty allow-list is a wiring error, not a narrower source — supply the ' +
          'lse_ticker values from the LSE ETP pool (buildLseMarkSource).',
      );
    }
    assertMarkableCurrencies(options.declaredCurrencies, client.vendor);
    this.#client = client;
    this.#tradeable = options.tradeable;
    this.#screeningInstruments = options.screeningInstruments ?? new Set<string>();
    this.#markTimeframe = options.markTimeframe ?? '1m';
  }

  protected override get markTimeframe(): string {
    return this.#markTimeframe;
  }

  #assertTradeable(instrument: string): void {
    if (this.#tradeable.has(instrument)) return;
    throw new NonTradeableInstrumentError(
      instrument,
      [...this.#tradeable],
      this.#screeningInstruments.has(instrument),
    );
  }

  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]> {
    this.#assertTradeable(instrument);
    const { currency, candles } = await this.#client.getBars(
      instrument,
      timeframe,
      asOf,
      limit,
      partial,
    );
    const toBook = (price: number): number =>
      toBookCurrency(price, currency, instrument, this.#client.vendor);

    return candles.map((candle) => ({
      open_time: candle.open_time,
      open: toBook(candle.open),
      high: toBook(candle.high),
      low: toBook(candle.low),
      close: toBook(candle.close),
      volume: candle.volume,
    }));
  }

  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    this.#assertTradeable(instrument);
    const quote = await this.#client.getLatestQuote(instrument);
    const raw = midpointOf(quote) ?? quote.price;

    return {
      price: toBookCurrency(raw, quote.currency, instrument, this.#client.vendor),
      observed_at: quote.observed_at,
    };
  }

  async fetchQuote(instrument: string): Promise<Quote | null> {
    this.#assertTradeable(instrument);
    const quote = await this.#client.getLatestQuote(instrument);
    if (quote.bid === undefined || quote.ask === undefined) return null;

    return {
      bid: toBookCurrency(quote.bid, quote.currency, instrument, this.#client.vendor),
      ask: toBookCurrency(quote.ask, quote.currency, instrument, this.#client.vendor),
      observed_at: quote.observed_at,
    };
  }
}

function midpointOf(quote: LseVendorQuote): number | null {
  if (quote.bid === undefined || quote.ask === undefined) return null;
  return (quote.bid + quote.ask) / 2;
}
