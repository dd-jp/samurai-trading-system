import type { SpendCap } from '../../../shared/debate/index.js';
import { classifyFailureCause } from '../../../shared/debate/index.js';
import type { AssetClass, Clock, Logger } from '../../../shared/index.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';

export const GROK_REFRESH_MS = 2 * 60 * 60 * 1000;

export interface GrokSentimentClient {
  fetchSentiment(
    instrument: string,
    asOf: Date,
  ): Promise<{
    items: IntelligenceItem[];
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    server_tool_calls?: number | undefined;
    retrievalEvidence: boolean;
    latency_ms: number;
    prompt?: string | undefined;
    raw_text?: string | undefined;
  }>;
}

export interface GrokSpendSink {
  record(entry: {
    trace_id: string;
    stage: string;
    model: string;
    prompt?: string | undefined;
    response?: string | undefined;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    server_tool_calls?: number | undefined;
    latency_ms: number;
    timestamp: Date;
  }): void;
}

export interface GrokAgentDeps {
  client: GrokSentimentClient;
  store: MarketIntelligenceStore;
  spendCap: SpendCap;
  spendSink: GrokSpendSink;
  clock: Clock;
  logger?: Logger;
  refreshMs?: number;
  archive?: MiArchiveStore | undefined;
}

export function floorToRefreshBucket(at: Date, refreshMs: number = GROK_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

interface XArchiveProjection {
  status_id: string;
  permalink: string;
  handle: string;
  posted_at: string;
  entity: string;
  sentiment: number;
  confidence: number;
  retrieved_at: string;
}

function toArchiveProjection(item: IntelligenceItem, retrievedAt: Date): XArchiveProjection | null {
  if (item.url === undefined) return null;
  const match = /^https?:\/\/(?:www\.)?x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})$/.exec(
    item.url,
  );
  const handle = match?.[1];
  const statusId = match?.[2];
  if (handle === undefined || statusId === undefined) return null;

  return {
    status_id: statusId,
    permalink: item.url,
    handle,
    posted_at: item.timestamp.toISOString(),
    entity: item.entity,
    sentiment: item.sentiment,
    confidence: item.confidence,
    retrieved_at: retrievedAt.toISOString(),
  };
}

export function retrievalEvidenceAbsentMessage(instrument: string, discarded: number): string {
  return discarded > 0
    ? `grok: discarding ${discarded} item(s) for ${instrument} — the ` +
        'response parsed cleanly but carried no evidence of retrieval (no citations, no ' +
        'tool step), so it cannot be told apart from model recall. Reporting NO DATA ' +
        'instead of risking confabulated sentiment as signal. See #485.'
    : `grok: no retrieval evidence for ${instrument} this call (no citations, no tool ` +
        'step) — reporting NO DATA. "Could not look" rather than "looked and saw ' +
        'nothing". See #485.';
}

export function refreshFailureMessage(
  instrument: string,
  detail: string,
  unroutedModel: boolean,
): string {
  return unroutedModel
    ? `grok: RETRIEVAL IS DARK for ${instrument} — the provider refused the server-side ` +
        `search tool for this model (${detail}). This is a configuration fault, not an ` +
        'outage: retries cannot fix it, and every subsequent call will fail the same way ' +
        'until the model is changed. The routed alias has probably re-resolved to a model ' +
        'that does not carry the tool. Expect the coverage alert for every instrument; ' +
        'this is its cause. See `X_SEARCH_MODEL` in x-search-client.ts.'
    : `grok: sentiment refresh failed for ${instrument} — ${detail}. The analysts will ` +
        'report NO DATA for this window; the bucket is NOT marked, so the next pass retries.';
}

export class GrokAgent {
  readonly #buckets = new Map<string, number>();
  readonly #deps: GrokAgentDeps;
  readonly #refreshMs: number;

  constructor(deps: GrokAgentDeps) {
    this.#deps = deps;
    this.#refreshMs = deps.refreshMs ?? GROK_REFRESH_MS;
  }

  async refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean> {
    const asOf = this.#deps.clock.now();
    const bucket = floorToRefreshBucket(asOf, this.#refreshMs).getTime();

    if (this.#buckets.get(instrument) === bucket) return false;

    const verdict = this.#deps.spendCap.check();
    if (!verdict.admitted) {
      this.#logSpendCapRefusal(trace_id, instrument, verdict);
      return false;
    }

    try {
      const result = await this.#deps.client.fetchSentiment(instrument, asOf);

      this.#deps.spendSink.record({
        trace_id,
        stage: 'market_intelligence',
        model: result.model,
        usage: result.usage,
        server_tool_calls: result.server_tool_calls,
        latency_ms: result.latency_ms,
        timestamp: asOf,
        prompt: result.prompt,
        response: result.raw_text,
      });

      const items = result.retrievalEvidence ? result.items : [];
      if (!result.retrievalEvidence) {
        this.#logRetrievalEvidenceAbsent(trace_id, instrument, result.items.length);
      }

      this.#archive(trace_id, items, asOf, assetClass);

      this.#deps.store.ingest({
        agent_id: 'grok',
        timestamp: asOf,
        asset_class: assetClass,
        items,
      });

      this.#buckets.set(instrument, bucket);
      return true;
    } catch (error) {
      this.#logRefreshFailure(trace_id, instrument, error);
      return false;
    }
  }

  #logSpendCapRefusal(
    trace_id: string,
    instrument: string,
    verdict: Extract<ReturnType<SpendCap['check']>, { admitted: false }>,
  ): void {
    this.#deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      event: 'grok_refresh_refused_spend_cap',
      level: 'warn',
      message:
        `grok: refusing to refresh ${instrument} — ${verdict.reason ?? 'spend cap reached'}. ` +
        'The analysts will report NO DATA for this window rather than a fabricated neutral ' +
        'item, so the debate can tell "could not afford to look" from "saw nothing".',
      payload: { instrument, spent_usd: verdict.spent_usd, budget_usd: verdict.budget_usd },
    });
  }

  #logRetrievalEvidenceAbsent(trace_id: string, instrument: string, discarded: number): void {
    this.#deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      event: 'grok_retrieval_evidence_absent',
      level: discarded > 0 ? 'warn' : 'info',
      message: retrievalEvidenceAbsentMessage(instrument, discarded),
      payload: { instrument, discarded_items: discarded },
    });
  }

  #logRefreshFailure(trace_id: string, instrument: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const unroutedModel = /search tools are not available|OpenRouter-routed/i.test(detail);
    this.#deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      event: 'grok_refresh_failed',
      level: 'error',
      message: refreshFailureMessage(instrument, detail, unroutedModel),
      payload: {
        instrument,
        failure_cause: classifyFailureCause(error),
        ...(unroutedModel ? { unrouted_model: true } : {}),
      },
    });
  }

  #archive(
    trace_id: string,
    items: readonly IntelligenceItem[],
    asOf: Date,
    assetClass: AssetClass,
  ): void {
    const archive = this.#deps.archive;
    if (archive === undefined || items.length === 0) return;

    const { raws, rows } = archiveRowsFor(items, asOf, assetClass);
    if (raws.length === 0) return;

    try {
      archive.write(raws, rows);
    } catch (error) {
      this.#logArchiveFailure(trace_id, raws.length, error);
    }
  }

  #logArchiveFailure(trace_id: string, count: number, error: unknown): void {
    this.#deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      event: 'grok_archive_write_failed',
      level: 'warn',
      message:
        `grok: archiving ${count} retrieved item(s) failed — ` +
        `${error instanceof Error ? error.message : String(error)}. The items still reached ` +
        'the live store, so this run is unaffected; what is lost is replay and the ' +
        'post-hoc bot-share check for this bucket.',
      payload: { items: count },
    });
  }
}

function archiveRowsFor(
  items: readonly IntelligenceItem[],
  asOf: Date,
  assetClass: AssetClass,
): { raws: RawArchiveRow[]; rows: ArchivedItem[] } {
  const raws: RawArchiveRow[] = [];
  const rows: ArchivedItem[] = [];

  for (const item of items) {
    const projection = toArchiveProjection(item, asOf);
    if (projection === null) continue;

    raws.push({
      source: MI_SOURCES.x,
      native_id: projection.status_id,
      updated_at: item.timestamp,
      payload: JSON.stringify(projection),
      ingested_at: asOf,
      fidelity: 'backfill',
    });

    rows.push({
      source: MI_SOURCES.x,
      native_id: projection.status_id,
      updated_at: item.timestamp,
      entity: item.entity,
      asset_class: assetClass,
      item,
      ingested_at: asOf,
    });
  }

  return { raws, rows };
}
