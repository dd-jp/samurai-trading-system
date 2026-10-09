import { fetchTokenUrl } from './token-url-fetch.js';

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

export function splitsUrl(apiKey: string, symbol: string, window: SplitsWindow): URL {
  const url = new URL(`${EODHD_API_URL}/splits/${encodeURIComponent(symbol)}`);
  url.searchParams.set('from', window.from);
  url.searchParams.set('to', window.to);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('api_token', apiKey);
  return url;
}

export class EodhdClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async splits(symbol: string, window: SplitsWindow): Promise<SplitsRead> {
    assertWindow(window);
    const asOf = this.now().toISOString().slice(0, 10);
    const response = await fetchTokenUrl(this.fetchImpl, splitsUrl(this.apiKey, symbol, window));
    if (typeof response === 'string') throw new EodhdRequestError(response);
    if (!response.ok) throw new EodhdRequestError(`http_${response.status}`);
    const body: unknown = await response.json().catch(() => undefined);
    return {
      symbol,
      from: window.from,
      to: window.to,
      asOf,
      splits: parseSplitsBody(body, window),
    };
  }
}
