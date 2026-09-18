import {
  type SpendCap,
  type SpendCapRefusalKind,
  type SpendCapVerdict,
  spendCapRefusalRemedy,
} from '../../../pipeline/debate-engine/index.js';
import type { AssetClass, Logger } from '../../../shared/index.js';
import { logCaughtFailure, runWithTraceId, safeLog } from '../../../shared/index.js';
import type { MarketIntelligenceRefresh } from './analysts-adapter.js';

export const MI_REFRESH_TRACE_ID = 'mi-refresh';

export const REFUSAL_LOG_EVERY = 20;

export interface MiRefreshQueueDeps {
  refresher: MarketIntelligenceRefresh;
  spendCap: SpendCap;
  logger?: Logger | undefined;
}

interface QueuedRefresh {
  instrument: string;
  assetClass: AssetClass;
  requestedBy: string;
}

export class MiRefreshQueue implements MarketIntelligenceRefresh {
  readonly #pending = new Map<string, QueuedRefresh>();

  #inFlight: string | undefined;

  #worker: Promise<void> | undefined;

  #stopped = false;

  readonly #refusalsByKind = new Map<SpendCapRefusalKind, number>();

  readonly #attempted = new Set<string>();

  constructor(private readonly deps: MiRefreshQueueDeps) {}

  async refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean> {
    if (this.#stopped) return false;
    if (this.#inFlight !== instrument && !this.#pending.has(instrument)) {
      this.#pending.set(instrument, { instrument, assetClass, requestedBy: trace_id });
    }
    this.#pump();
    return false;
  }

  refreshAttempted(instrument: string): boolean {
    return this.#attempted.has(instrument);
  }

  get depth(): number {
    return this.#pending.size + (this.#inFlight === undefined ? 0 : 1);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending.clear();
    await this.#worker;
  }

  #pump(): void {
    if (this.#worker !== undefined) return;
    const worker = Promise.resolve().then(() =>
      runWithTraceId(MI_REFRESH_TRACE_ID, () => this.#drain()),
    );
    this.#worker = worker;
    const rearm = (): void => {
      this.#worker = undefined;
      if (!this.#stopped && this.#pending.size > 0) this.#pump();
    };
    void worker.then(rearm, rearm);
  }

  async #drain(): Promise<void> {
    while (!this.#stopped && this.#pending.size > 0) {
      const next = this.#pending.values().next();
      if (next.done === true) return;
      const request = next.value;
      this.#pending.delete(request.instrument);
      this.#inFlight = request.instrument;
      try {
        await this.#dispatch(request);
      } finally {
        this.#attempted.add(request.instrument);
        this.#inFlight = undefined;
      }
    }
  }

  async #dispatch(request: QueuedRefresh): Promise<void> {
    try {
      const spend = this.deps.spendCap.check();
      if (!spend.admitted) {
        this.#logRefusal(request, spend);
        return;
      }
      await this.deps.refresher.refresh(
        MI_REFRESH_TRACE_ID,
        request.instrument,
        request.assetClass,
      );
    } catch (error) {
      if (this.deps.logger !== undefined) {
        logCaughtFailure(
          this.deps.logger,
          {
            trace_id: MI_REFRESH_TRACE_ID,
            stage: 'market_intelligence',
            event: 'mi_refresh_threw',
            level: 'warn',
            message:
              `market intelligence: the queued refresh for ${request.instrument} threw; that ` +
              'name adds nothing this sweep and its news-fed analysts will report NO DATA. ' +
              'Not fatal — the queue continues with the next instrument.',
          },
          error,
        );
      }
    }
  }

  #logRefusal(request: QueuedRefresh, spend: Extract<SpendCapVerdict, { admitted: false }>): void {
    const refusalsOfKind = (this.#refusalsByKind.get(spend.kind) ?? 0) + 1;
    this.#refusalsByKind.set(spend.kind, refusalsOfKind);
    if (refusalsOfKind !== 1 && refusalsOfKind % REFUSAL_LOG_EVERY !== 0) return;
    if (this.deps.logger === undefined) return;
    safeLog(this.deps.logger, {
      trace_id: MI_REFRESH_TRACE_ID,
      stage: 'market_intelligence',
      event: 'mi_refresh_refused_spend_cap',
      level: 'warn',
      message:
        `market intelligence: refresh for ${request.instrument} not started — ` +
        `${spend.reason ?? 'spend cap reached'}. No LLM call was made. ` +
        `${spendCapRefusalRemedy(spend.kind)} The news-fed analysts report NO DATA ` +
        'on whatever the archive already holds.',
      payload: {
        instrument: request.instrument,
        asset_class: request.assetClass,
        requested_by: request.requestedBy,
        spent_usd: spend.spent_usd,
        budget_usd: spend.budget_usd,
        kind: spend.kind,
        refusals_of_kind: refusalsOfKind,
      },
    });
  }
}
