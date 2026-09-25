import { resolveSaxoOAuthConfig } from '../../../pipeline/execution/adapters/saxo-oauth.js';
import { tokenFilePath } from '../../../pipeline/execution/adapters/saxo-token-file.js';
import type { SaxoTokenSource } from '../../../pipeline/execution/adapters/saxo-token-source.js';
import { SaxoTokenRefresher } from '../../../pipeline/execution/adapters/saxo-token-source.js';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import type { Logger } from '../../../shared/index.js';
import { isFiniteNumber, maskCredentials } from '../../../shared/index.js';
import type { FetchResult, Sleeper } from './alpaca-bars-api.js';

export const SAXO_CHART_PAGE = 1200;
const CHART_CALLS_PER_MINUTE = 100;
const RATE_LIMIT_BACKOFF_MS = 65_000;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 60_000;

export type SaxoAssetType = 'Etf' | 'Etc';

export interface ChartSample {
  readonly Time: string;
  readonly Open: number;
  readonly High: number;
  readonly Low: number;
  readonly Close: number;
  readonly Volume: number;
}

export interface ChartPage {
  readonly firstSampleTime: string | undefined;
  readonly delayedByMinutes: number | undefined;
  readonly samples: ChartSample[];
}

export type SaxoFetcher = (url: string, accessToken: string) => Promise<FetchResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseChartPage(body: unknown): ChartPage {
  if (!isRecord(body)) throw new Error('Saxo chart: non-object body');
  const info = isRecord(body.ChartInfo) ? body.ChartInfo : {};
  const data = body.Data;
  if (!Array.isArray(data)) throw new Error('Saxo chart: Data is not an array');
  return {
    firstSampleTime: typeof info.FirstSampleTime === 'string' ? info.FirstSampleTime : undefined,
    delayedByMinutes: isFiniteNumber(info.DelayedByMinutes) ? info.DelayedByMinutes : undefined,
    samples: data.map(parseSample),
  };
}

function parseSample(item: unknown): ChartSample {
  if (isRecord(item)) {
    const { Time, Open, High, Low, Close, Volume } = item;
    if (
      typeof Time === 'string' &&
      isFiniteNumber(Open) &&
      isFiniteNumber(High) &&
      isFiniteNumber(Low) &&
      isFiniteNumber(Close) &&
      isFiniteNumber(Volume)
    ) {
      return { Time, Open, High, Low, Close, Volume };
    }
  }
  throw new Error(`Saxo chart: malformed sample ${JSON.stringify(item)}`);
}

export function samplesToBars(samples: readonly ChartSample[], cashPerQuoted: number): DailyBar[] {
  if (!(cashPerQuoted > 0)) throw new Error(`samplesToBars: bad unit factor ${cashPerQuoted}`);
  const bars = samples.map((sample) => {
    const close = sample.Close * cashPerQuoted;
    return {
      date: sample.Time.slice(0, 10),
      open: sample.Open * cashPerQuoted,
      high: sample.High * cashPerQuoted,
      low: sample.Low * cashPerQuoted,
      close,
      volume: sample.Volume,
      rawClose: close,
    };
  });
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

export function mergeChartPages(pages: readonly (readonly ChartSample[])[]): ChartSample[] {
  const byTime = new Map<string, ChartSample>();
  for (const page of pages) for (const sample of page) byTime.set(sample.Time, sample);
  return [...byTime.values()].sort((a, b) => a.Time.localeCompare(b.Time));
}

export interface InstrumentDetails {
  readonly symbol: string;
  readonly currencyCode: string;
  readonly priceToContractFactor: number;
  readonly isTradable: boolean;
  readonly isComplex: boolean;
  readonly exchangeId: string;
}

export function parseInstrumentDetails(body: unknown): InstrumentDetails {
  if (!isRecord(body)) throw new Error('Saxo details: non-object body');
  const exchange = isRecord(body.Exchange) ? body.Exchange.ExchangeId : undefined;
  return {
    symbol: String(body.Symbol ?? ''),
    currencyCode: String(body.CurrencyCode ?? ''),
    priceToContractFactor: isFiniteNumber(body.PriceToContractFactor)
      ? body.PriceToContractFactor
      : 1,
    isTradable: body.IsTradable === true,
    isComplex: body.IsComplex === true,
    exchangeId: String(exchange ?? body.ExchangeId ?? ''),
  };
}

export interface InfoPriceQuote {
  readonly uic: number;
  readonly bid: number;
  readonly ask: number;
  readonly delayedByMinutes: number | undefined;
  readonly marketState: string;
  readonly lastUpdated: string;
}

export function parseInfoPricesList(body: unknown): InfoPriceQuote[] {
  if (!isRecord(body) || !Array.isArray(body.Data))
    throw new Error('Saxo infoprices/list: Data missing');
  return body.Data.flatMap((item: unknown) => {
    const quote = parseInfoPriceQuote(item);
    return quote === undefined ? [] : [quote];
  });
}

function parseInfoPriceQuote(item: unknown): InfoPriceQuote | undefined {
  if (!isRecord(item) || !isRecord(item.Quote) || !isFiniteNumber(item.Uic)) return undefined;
  const { Bid, Ask, DelayedByMinutes, MarketState } = item.Quote;
  if (!isFiniteNumber(Bid) || !isFiniteNumber(Ask) || !(Bid > 0) || !(Ask >= Bid)) return undefined;
  return {
    uic: item.Uic,
    bid: Bid,
    ask: Ask,
    delayedByMinutes: isFiniteNumber(DelayedByMinutes) ? DelayedByMinutes : undefined,
    marketState: String(MarketState ?? ''),
    lastUpdated: String(item.LastUpdated ?? ''),
  };
}

const consoleLogger: Logger = {
  log: (entry) => console.log(maskCredentials(`${entry.event ?? entry.level}: ${entry.message}`)),
};

export function liveTokenSource(env: NodeJS.ProcessEnv, tokenPath?: string): SaxoTokenRefresher {
  const refresher = new SaxoTokenRefresher({
    environment: 'live',
    config: resolveSaxoOAuthConfig('live', env),
    tokenPath: tokenPath ?? tokenFilePath('live'),
    logger: consoleLogger,
  });
  const state = refresher.start();
  if (state.status !== 'active') {
    throw new Error(
      `Saxo token dead, needs \`npm run saxo:login\` (${state.status === 'lost' ? state.reason : 'unrefreshable'})`,
    );
  }
  return refresher;
}

export class SaxoReadOnlyApi {
  private readonly chartCalls: number[] = [];

  constructor(
    private readonly tokens: SaxoTokenSource,
    private readonly gatewayBaseUrl: string,
    private readonly fetcher: SaxoFetcher = jsonFetcher,
    private readonly sleep: Sleeper = defaultSleep,
  ) {}

  async dailyHistory(uic: number, assetType: SaxoAssetType): Promise<ChartPage> {
    const pages: ChartSample[][] = [];
    const first = await this.chartPage(uic, assetType, undefined);
    pages.push(first.samples);
    let earliest = first.samples[0]?.Time;
    let raw = first.samples.length;
    while (raw === SAXO_CHART_PAGE && earliest !== undefined) {
      const page = await this.chartPage(uic, assetType, earliest);
      raw = page.samples.length;
      const older = page.samples.filter((sample) => sample.Time < (earliest as string));
      if (older.length === 0) break;
      pages.push(older);
      earliest = older[0]?.Time;
    }
    return {
      firstSampleTime: first.firstSampleTime,
      delayedByMinutes: first.delayedByMinutes,
      samples: mergeChartPages(pages),
    };
  }

  private async chartPage(
    uic: number,
    assetType: SaxoAssetType,
    upTo: string | undefined,
  ): Promise<ChartPage> {
    const params: Record<string, string> = {
      Uic: String(uic),
      AssetType: assetType,
      Horizon: '1440',
      Count: String(SAXO_CHART_PAGE),
      FieldGroups: upTo === undefined ? 'ChartInfo,Data' : 'Data',
    };
    if (upTo !== undefined) {
      params.Mode = 'UpTo';
      params.Time = upTo;
    }
    await this.paceChart();
    return parseChartPage(await this.get('/chart/v3/charts', params));
  }

  async instrumentDetails(uic: number, assetType: SaxoAssetType): Promise<InstrumentDetails> {
    return parseInstrumentDetails(
      await this.get(`/ref/v1/instruments/details/${uic}/${assetType}`),
    );
  }

  async infoPrices(uics: readonly number[]): Promise<InfoPriceQuote[]> {
    return parseInfoPricesList(
      await this.get('/trade/v1/infoprices/list', {
        Uics: uics.join(','),
        AssetType: 'Etf',
        FieldGroups: 'Quote',
      }),
    );
  }

  private async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const query = params === undefined ? '' : `?${new URLSearchParams(params).toString()}`;
    const url = `${this.gatewayBaseUrl.replace(/\/+$/, '')}${path}${query}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await this.fetcher(url, await this.tokens.getAccessToken());
      if (result.status === 200) return result.body;
      if (result.status === 429) {
        await this.sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      if (result.status === 401 && attempt < MAX_ATTEMPTS) {
        await this.sleep(2_000);
        continue;
      }
      throw new Error(
        `Saxo ${result.status} for ${path}: ${JSON.stringify(result.body).slice(0, 300)}`,
      );
    }
    throw new Error(`Saxo: ${MAX_ATTEMPTS} attempts exhausted for ${path}`);
  }

  private async paceChart(): Promise<void> {
    const now = Date.now();
    while (this.chartCalls.length > 0 && now - (this.chartCalls[0] as number) > 60_000) {
      this.chartCalls.shift();
    }
    if (this.chartCalls.length >= CHART_CALLS_PER_MINUTE) {
      await this.sleep(60_000 - (now - (this.chartCalls[0] as number)) + 500);
      this.chartCalls.shift();
    }
    this.chartCalls.push(Date.now());
  }
}

async function jsonFetcher(url: string, accessToken: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
