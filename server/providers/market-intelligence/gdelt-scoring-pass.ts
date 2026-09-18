
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type { AssetClass, Clock, LogEntry, LogEntryTemplate, Logger } from '../../shared/index.js';
import { logCaughtFailure, safeLog } from '../../shared/index.js';
import type { MiArchiveStore, RawArchiveRow } from './archive/mi-archive-store.js';
import { MI_SOURCES } from './archive/mi-sources.js';
import type { MarketIntelligenceStore } from './index.js';
import {
  DEFAULT_GDELT_WINDOWS,
  deriveGdeltAggregate,
  type GdeltRefusalReason,
  type GdeltWindows,
} from './sources/gdelt-scorer.js';

const SOURCE_GDELT = MI_SOURCES.gdeltGkg;

const REFUSAL_LOG_AFTER_CONSECUTIVE = 1;

export const REFUSAL_REPEAT_EVERY = 36;

export function shouldLogRefusalAt(consecutive: number): boolean {
  if (consecutive < REFUSAL_LOG_AFTER_CONSECUTIVE) return false;
  return (consecutive - REFUSAL_LOG_AFTER_CONSECUTIVE) % REFUSAL_REPEAT_EVERY === 0;
}

const REFUSAL_LEVEL: Record<GdeltRefusalReason, 'warn' | 'info'> = {
  baseline_far_end_empty: 'warn',
  baseline_too_sparse: 'warn',
  signal_window_thin: 'info',
};

const REFUSAL_MESSAGE: Record<GdeltRefusalReason, string> = {
  baseline_far_end_empty:
    'market intelligence: GDELT scoring refused — the 24h baseline does not reach back a full ' +
    'window, so no macro aggregate was emitted. Expected on a cold archive: the archive leads ' +
    'the signal by a full baseline window by design, and this clears itself once 24h of batches ' +
    'have accrued. Persisting past that means the fetcher is not archiving.',
  baseline_too_sparse:
    'market intelligence: GDELT scoring refused — the 24h baseline is too sparse to be a level, ' +
    'so no macro aggregate was emitted. A tone delta measured against a gapped or thin baseline ' +
    'would land as a high-confidence signal built out of almost nothing.',
  signal_window_thin:
    'market intelligence: GDELT signal window is quiet — too few matched records in the last ' +
    'hour to take a tone delta, so no macro aggregate this bar. Not a fault: a quiet hour is ' +
    'normal and self-correcting.',
};

interface SharedBarRead {
  windows: GdeltWindows;
  end: () => Date;
  rows: () => readonly RawArchiveRow[];
}

export interface GdeltScoringPassDeps {
  archive: MiArchiveStore;
  store: MarketIntelligenceStore;
  clock: Clock;
  assetClasses: readonly AssetClass[];
  logger?: Logger | undefined;
  windows?: GdeltWindows | undefined;
}

export class GdeltScoringPass {
  readonly #emittedBar = new Map<AssetClass, number>();
  readonly #refusals = new Map<AssetClass, { reason: GdeltRefusalReason; consecutive: number }>();

  constructor(private readonly deps: GdeltScoringPassDeps) {}

  private log(entry: LogEntry): void {
    const logger = this.deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  private logFailure(
    template: LogEntryTemplate,
    error: unknown,
    payload: Record<string, unknown>,
  ): void {
    const logger = this.deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

  run(trace_id = 'gdelt-scoring'): void {
    const bar = this.sharedBarRead();
    for (const asset_class of this.deps.assetClasses) {
      try {
        this.derive(trace_id, asset_class, bar);
      } catch (error) {
        this.logFailure(
          {
            trace_id,
            stage: 'market_intelligence',
            event: 'gdelt_scoring_failed',
            level: 'warn',
            message:
              'market intelligence: GDELT scoring pass failed; no macro aggregate this poll. ' +
              'Not fatal — the archive is unchanged and the next poll re-derives.',
          },
          error,
          { source: SOURCE_GDELT, asset_class },
        );
      }
    }
  }

  private sharedBarRead(): SharedBarRead {
    const windows = this.deps.windows ?? DEFAULT_GDELT_WINDOWS;
    let windowEnd: Date | undefined;
    let rows: readonly RawArchiveRow[] | undefined;

    const end = (): Date =>
      (windowEnd ??= floorToBar(this.deps.clock.now(), DEBATE_BAR_TIMEFRAME_MS));

    return {
      windows,
      end,
      rows: () => {
        if (rows === undefined) {
          const to = end();
          const from = new Date(to.getTime() - windows.signalWindowMs - windows.baselineWindowMs);
          rows = this.deps.archive.rawRowsBetween(SOURCE_GDELT, from, to);
        }
        return rows;
      },
    };
  }

  private derive(trace_id: string, asset_class: AssetClass, bar: SharedBarRead): void {
    const windows = bar.windows;
    const windowEnd = bar.end();
    if (this.#emittedBar.get(asset_class) === windowEnd.getTime()) return;

    const derivation = deriveGdeltAggregate(bar.rows(), { asset_class, windowEnd, windows });

    if (!derivation.emitted) {
      const previous = this.#refusals.get(asset_class);
      const consecutive =
        previous === undefined || previous.reason !== derivation.reason
          ? 1
          : previous.consecutive + 1;
      this.#refusals.set(asset_class, { reason: derivation.reason, consecutive });
      if (shouldLogRefusalAt(consecutive)) {
        this.log({
          trace_id,
          stage: 'market_intelligence',
          event: 'gdelt_scoring_refused',
          level: REFUSAL_LEVEL[derivation.reason],
          message: REFUSAL_MESSAGE[derivation.reason],
          payload: {
            source: SOURCE_GDELT,
            asset_class,
            reason: derivation.reason,
            window_end: windowEnd.toISOString(),
            consecutive,
            ...derivation.stats,
          },
        });
      }
      return;
    }

    this.deps.store.ingest({
      agent_id: SOURCE_GDELT,
      timestamp: this.deps.clock.now(),
      asset_class,
      items: [derivation.item],
    });
    this.#emittedBar.set(asset_class, windowEnd.getTime());
    this.#refusals.delete(asset_class);

    this.log({
      trace_id,
      stage: 'market_intelligence',
      level: 'info',
      message: 'market intelligence: derived GDELT macro aggregate',
      payload: {
        source: SOURCE_GDELT,
        asset_class,
        entity: derivation.item.entity,
        window_end: windowEnd.toISOString(),
        sentiment: derivation.item.sentiment,
        confidence: derivation.item.confidence,
        ...derivation.stats,
      },
    });
  }
}
