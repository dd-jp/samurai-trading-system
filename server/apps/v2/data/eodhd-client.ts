import { fetchTokenUrl } from './token-url-fetch.js';
import { PENCE_PER_POUND } from './uk-stocks.js';

export const EODHD_API_URL = 'https://eodhd.com/api';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPLIT_TEXT = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;

export type EodhdExchange = 'US' | 'LSE';

export interface SplitsWindow {
  readonly from: string;
  readonly to: string;
}

export interface EodhdSplit {
  readonly date: string;
  readonly ratio: number;
}

export interface SplitsRead extends SplitsWindow {
  readonly symbol: string;
  readonly asOf: string;
  readonly splits: readonly EodhdSplit[];
}

export interface EodhdDividend {
  readonly exDate: string;
  readonly perShare: number;
  readonly currency: string;
}

export interface DividendsRead extends SplitsWindow {
  readonly symbol: string;
  readonly asOf: string;
  readonly dividends: readonly EodhdDividend[];
}

export class EodhdRequestError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function eodhdSymbol(symbol: string, exchange: EodhdExchange): string {
  return `${symbol.replaceAll('.', '-')}.${exchange}`;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
}

export function assertWindow(window: SplitsWindow): void {
  if (!isIsoDate(window.from) || !isIsoDate(window.to) || window.from > window.to) {
    throw new EodhdRequestError('bad_window');
  }
}

// EODHD writes a split as "new/old" shares, so a 1:200 reverse split is "1.000000/200.000000"
export function parseSplitRatio(text: unknown): number | undefined {
  const match = typeof text === 'string' ? SPLIT_TEXT.exec(text) : null;
  if (match === null) return undefined;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

function parseSplit(raw: unknown): EodhdSplit {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const ratio = parseSplitRatio(record.split);
  if (!isIsoDate(record.date) || ratio === undefined) throw new EodhdRequestError('bad_body');
  return { date: record.date, ratio };
}

// a split outside the asked window means the from/to filter was not applied, so the read vouches for nothing
export function parseSplitsBody(body: unknown, window: SplitsWindow): readonly EodhdSplit[] {
  if (!Array.isArray(body)) throw new EodhdRequestError('bad_body');
  const splits = body.map(parseSplit).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(splits.map((split) => split.date)).size < splits.length) {
    throw new EodhdRequestError('bad_body');
  }
  if (splits.some((split) => split.date < window.from || split.date > window.to)) {
    throw new EodhdRequestError('out_of_window');
  }
  return splits;
}

// GBX and GBp are pence on an LSE line; any other currency is kept as declared for the booking to
// convert at the mark FX or refuse
const PENCE: ReadonlySet<string> = new Set(['GBX', 'GBp']);

function exchangeOfSymbol(symbol: string): EodhdExchange {
  const suffix = symbol.slice(symbol.lastIndexOf('.') + 1);
  if (suffix !== 'LSE' && suffix !== 'US') throw new EodhdRequestError('bad_symbol');
  return suffix;
}

function dividendRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

// unadjustedValue is the cash per share as the share traded on its ex-date; value is restated
// for every later split, so a history read years on would misprice any name that split since
function parseDividend(raw: unknown, exchange: EodhdExchange): EodhdDividend {
  const record = dividendRecord(raw);
  const amount = record.unadjustedValue;
  if (!isIsoDate(record.date) || typeof amount !== 'number' || !(amount > 0)) {
    throw new EodhdRequestError('bad_body');
  }
  const currency = typeof record.currency === 'string' ? record.currency : '';
  if (exchange === 'LSE' && PENCE.has(currency)) {
    return { exDate: record.date, perShare: amount / PENCE_PER_POUND, currency: 'GBP' };
  }
  return { exDate: record.date, perShare: amount, currency };
}

function hasRepeatedRecord(body: readonly unknown[]): boolean {
  const seen = new Set(body.map((raw) => JSON.stringify(dividendRecord(raw))));
  return seen.size < body.length;
}

// A regular and a special dividend can share an ex-date and are both paid, so they stay two
// entries; a record repeated field for field is a feed duplicate and the read is refused
export function parseDividendsBody(
  body: unknown,
  symbol: string,
  window: SplitsWindow,
): readonly EodhdDividend[] {
  const exchange = exchangeOfSymbol(symbol);
  if (!Array.isArray(body) || hasRepeatedRecord(body)) throw new EodhdRequestError('bad_body');
  const dividends = body
    .map((raw) => parseDividend(raw, exchange))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
  if (dividends.some(({ exDate }) => exDate < window.from || exDate > window.to)) {
    throw new EodhdRequestError('out_of_window');
  }
  return dividends;
}

function windowUrl(apiKey: string, path: string, symbol: string, window: SplitsWindow): URL {
  const url = new URL(`${EODHD_API_URL}/${path}/${encodeURIComponent(symbol)}`);
  url.searchParams.set('from', window.from);
  url.searchParams.set('to', window.to);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('api_token', apiKey);
  return url;
}

export function dividendsUrl(apiKey: string, symbol: string, window: SplitsWindow): URL {
  return windowUrl(apiKey, 'div', symbol, window);
}

export function splitsUrl(apiKey: string, symbol: string, window: SplitsWindow): URL {
  return windowUrl(apiKey, 'splits', symbol, window);
}

export class EodhdClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async #body(url: URL): Promise<unknown> {
    const response = await fetchTokenUrl(this.fetchImpl, url);
    if (typeof response === 'string') throw new EodhdRequestError(response);
    if (!response.ok) throw new EodhdRequestError(`http_${response.status}`);
    return response.json().catch(() => undefined);
  }

  async splits(symbol: string, window: SplitsWindow): Promise<SplitsRead> {
    assertWindow(window);
    const asOf = this.now().toISOString().slice(0, 10);
    const body = await this.#body(splitsUrl(this.apiKey, symbol, window));
    return {
      symbol,
      from: window.from,
      to: window.to,
      asOf,
      splits: parseSplitsBody(body, window),
    };
  }

  async dividends(symbol: string, window: SplitsWindow): Promise<DividendsRead> {
    assertWindow(window);
    const asOf = this.now().toISOString().slice(0, 10);
    const body = await this.#body(dividendsUrl(this.apiKey, symbol, window));
    return {
      symbol,
      from: window.from,
      to: window.to,
      asOf,
      dividends: parseDividendsBody(body, symbol, window),
    };
  }
}
