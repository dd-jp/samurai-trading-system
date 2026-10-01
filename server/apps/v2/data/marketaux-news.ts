import type { Logger } from '../../../shared/index.js';
import { addDays } from './macro-calendar.js';
import {
  type MarketauxArticle,
  type MarketauxFetch,
  MarketauxRequestError,
  type MarketauxResult,
} from './marketaux-client.js';
import { MAX_HEADLINES_PER_NAME, type NewsSource, ROUNDUP_SYMBOL_LIMIT } from './news.js';
import type {
  NewsLedger,
  NewsRecord,
  NewsStatus,
  NewsUsage,
  StoredHeadline,
} from './news-ledger.js';

export const MARKETAUX_PROVIDER = 'marketaux';
// free tier is 100 requests a day; the gap covers manual probes on the same key and an unknown reset timezone
export const MARKETAUX_REQUEST_CEILING = 80;
// documented 429 is "too many requests in the past 60 seconds"
const MARKETAUX_RATE_LIMIT_PAUSE_MS = 60_000;
// probe window was 30 days; a name averages under one article a day, so one day would leave most names empty
export const MARKETAUX_LOOKBACK_CALENDAR_DAYS = 3;

export interface NewsWindow {
  readonly start: Date;
  readonly end: Date;
}

export function newsWindow(tradingDate: string, now: Date): NewsWindow | undefined {
  const start = new Date(
    `${addDays(tradingDate, -MARKETAUX_LOOKBACK_CALENDAR_DAYS)}T00:00:00.000Z`,
  );
  return start.getTime() < now.getTime() ? { start, end: now } : undefined;
}

export function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export type Admission = 'admit' | 'budget_stop' | 'provider_quota_refused';

export function admission(
  usage: NewsUsage,
  ceiling: number = MARKETAUX_REQUEST_CEILING,
): Admission {
  if (usage.quotaRefused) return 'provider_quota_refused';
  return usage.requests >= ceiling ? 'budget_stop' : 'admit';
}

export interface WindowCoverage {
  readonly inWindow: readonly MarketauxArticle[];
  readonly outOfWindow: number;
}

export function windowCoverage(
  articles: readonly MarketauxArticle[],
  window: NewsWindow,
): WindowCoverage {
  const inWindow = articles.filter((article) => {
    const published = Date.parse(article.publishedAt);
    return published >= window.start.getTime() && published < window.end.getTime();
  });
  return { inWindow, outOfWindow: articles.length - inWindow.length };
}

export function selectHeadlines(articles: readonly MarketauxArticle[]): {
  readonly headlines: readonly StoredHeadline[];
  readonly roundups: number;
} {
  const perName = articles.filter((article) => article.companyCount <= ROUNDUP_SYMBOL_LIMIT);
  const headlines = perName
    .map((article) => ({
      title: article.title.trim(),
      publishedAt: new Date(article.publishedAt).toISOString(),
    }))
    .filter((headline) => headline.title.length > 0)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(-MAX_HEADLINES_PER_NAME);
  return { headlines, roundups: articles.length - perName.length };
}

function notes(parts: Record<string, number>): string {
  return Object.entries(parts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(',');
}

export function classify(
  result: MarketauxResult,
  window: NewsWindow,
): Pick<NewsRecord, 'status' | 'reason' | 'found' | 'headlines'> {
  const { inWindow, outOfWindow } = windowCoverage(result.articles, window);
  const { headlines, roundups } = selectHeadlines(inWindow);
  const truncated = Math.max(0, result.found - result.articles.length);
  const detail = notes({
    found: result.found,
    truncated,
    out_of_window: outOfWindow,
    roundup: roundups,
  });
  const status: NewsStatus = headlines.length > 0 ? 'ok' : 'no_news';
  const reason = status === 'no_news' && result.found === 0 ? 'empty' : detail;
  return { status, reason, found: result.found, headlines };
}

export function pointInTime(headlines: readonly StoredHeadline[], now: Date): readonly string[] {
  return headlines
    .filter((headline) => Date.parse(headline.publishedAt) < now.getTime())
    .map((headline) => headline.title);
}

export interface UkNewsCoverage {
  readonly names: number;
  readonly withHeadlines: number;
  readonly noNews: number;
  readonly byStatus: Readonly<Record<NewsStatus, number>>;
}

export function ukNewsCoverage(records: readonly NewsRecord[]): UkNewsCoverage {
  const latest = new Map<string, NewsRecord>();
  for (const record of records) latest.set(record.symbol, record);
  const byStatus: Record<NewsStatus, number> = {
    ok: 0,
    no_news: 0,
    error: 0,
    budget_stop: 0,
    no_key: 0,
  };
  for (const record of latest.values()) byStatus[record.status] += 1;
  return {
    names: latest.size,
    withHeadlines: byStatus.ok,
    noNews: latest.size - byStatus.ok,
    byStatus,
  };
}

export function isDegraded(coverage: UkNewsCoverage): boolean {
  return coverage.byStatus.error + coverage.byStatus.budget_stop + coverage.byStatus.no_key > 0;
}

export interface MarketauxNewsDeps {
  readonly client: MarketauxFetch | undefined;
  readonly ledger: NewsLedger;
  readonly logger?: Logger | undefined;
  readonly ceiling?: number | undefined;
}

function failureReason(error: unknown): string {
  return error instanceof MarketauxRequestError ? error.reason : 'internal';
}

type RecordBase = Pick<NewsRecord, 'tradingDate' | 'symbol' | 'provider' | 'fetchedAt'>;

type Preflight =
  | { readonly refused: NewsRecord }
  | { readonly client: MarketauxFetch; readonly window: NewsWindow };

export class MarketauxNewsSource implements NewsSource {
  #rateLimitedUntil = 0;

  constructor(private readonly deps: MarketauxNewsDeps) {}

  async headlines(tidm: string, tradingDate: string, now: Date): Promise<readonly string[]> {
    try {
      const record = await this.#resolve(tidm, tradingDate, now);
      return pointInTime(record.headlines, now);
    } catch (error) {
      this.#logFailure(tidm, tradingDate, error);
      return [];
    }
  }

  journalCoverage(tradingDate: string): UkNewsCoverage | undefined {
    try {
      return this.#logCoverage(tradingDate);
    } catch (error) {
      this.#logFailure('coverage', tradingDate, error);
      return undefined;
    }
  }

  #logCoverage(tradingDate: string): UkNewsCoverage | undefined {
    const coverage = ukNewsCoverage(this.deps.ledger.forDate(tradingDate, MARKETAUX_PROVIDER));
    if (coverage.names === 0) return undefined;
    this.deps.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: isDegraded(coverage) ? 'warn' : 'info',
      event: 'v2_uk_news_coverage',
      message: `UK news: ${coverage.withHeadlines} of ${coverage.names} names had headlines, ${coverage.noNews} NO_NEWS`,
      payload: { trading_date: tradingDate, ...coverage },
    });
    return coverage;
  }

  async #resolve(tidm: string, tradingDate: string, now: Date): Promise<NewsRecord> {
    const cached = this.deps.ledger.cached(MARKETAUX_PROVIDER, tradingDate, tidm);
    if (cached !== undefined) return cached;
    const record = await this.#fetch(tidm, tradingDate, now);
    this.deps.ledger.record(record);
    return record;
  }

  async #fetch(tidm: string, tradingDate: string, now: Date): Promise<NewsRecord> {
    const base = {
      tradingDate,
      symbol: tidm,
      provider: MARKETAUX_PROVIDER,
      fetchedAt: now.toISOString(),
    };
    const preflight = this.#preflight(base, now);
    if ('refused' in preflight) return preflight.refused;
    try {
      const result = await preflight.client.fetchArticles(
        tidm,
        preflight.window.start,
        preflight.window.end,
      );
      return { ...base, requested: true, ...classify(result, preflight.window) };
    } catch (error) {
      const reason = failureReason(error);
      if (reason === 'http_429') this.#pauseFrom(now);
      return { ...base, requested: true, found: undefined, headlines: [], status: 'error', reason };
    }
  }

  #pauseFrom(now: Date): void {
    this.#rateLimitedUntil = now.getTime() + MARKETAUX_RATE_LIMIT_PAUSE_MS;
  }

  #preflight(base: RecordBase, now: Date): Preflight {
    const refuse = (status: NewsStatus, reason: string): Preflight => ({
      refused: { ...base, status, reason, requested: false, found: undefined, headlines: [] },
    });
    const { client } = this.deps;
    if (client === undefined) return refuse('no_key', 'no_api_key');
    const window = newsWindow(base.tradingDate, now);
    if (window === undefined) return refuse('no_news', 'window_not_open');
    const verdict = admission(
      this.deps.ledger.usageSince(MARKETAUX_PROVIDER, utcDayStart(now)),
      this.deps.ceiling,
    );
    if (verdict !== 'admit') return refuse('budget_stop', verdict);
    if (now.getTime() < this.#rateLimitedUntil) return refuse('budget_stop', 'rate_limited');
    return { client, window };
  }

  #logFailure(tidm: string, tradingDate: string, error: unknown): void {
    this.deps.logger?.log({
      trace_id: `v2-${tradingDate}-${tidm}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_uk_news_failed',
      message: `UK news for ${tidm} failed: ${failureReason(error)}`,
    });
  }
}
