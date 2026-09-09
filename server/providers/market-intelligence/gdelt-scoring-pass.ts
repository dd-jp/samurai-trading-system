/**
 * GDELT scoring — the read-side half of #556, wired by #1086.
 *
 * `GdeltIngestAgent` archives raw GKG bytes and emits nothing. This pass is
 * what turns that archive into intelligence the analysts can see: once per
 * debate bar it reads the 25-hour slice behind the bar, and per asset class
 * derives one aggregate from that slice through `gdelt-scorer.ts` and ingests
 * it into `MarketIntelligenceStore`.
 *
 * ## Derived at read, nothing stored (#556 point 3)
 *
 * It writes NO `mi_items`. The archive keeps vendor bytes; the score is a
 * function of those bytes and a window spec, recomputed every time. That is
 * the property #556 asked for — the window and baseline lengths stay
 * changeable retroactively over history already collected — and it is why
 * `MI_SOURCE_HYDRATION` keeps this source `archive-only`: there is nothing on
 * disk to re-serve at boot, and a trailing statistic should not be re-served
 * anyway.
 *
 * Note what this means for replay, plainly, because the opposite claim would
 * be the tempting one: GDELT is re-DERIVABLE from raw, not replayable from
 * `mi_items`. Anything wanting a historical series of these aggregates calls
 * `deriveGdeltAggregate` over the archive itself, at whatever window it wants.
 *
 * ## Off the analyst critical path
 *
 * Driven from `production.ts`'s own GDELT timer, after each poll — not from
 * the analyst stage. The analyst stage reads the STORE (#1085 moved even MI
 * refresh off that path), so what it costs a tick is nothing. What it costs
 * the timer is one indexed SQLite range read (migration 0003) per BAR —
 * ~20,000 rows on the 2026-09-03 paper archive's cadence, against 168,026
 * GDELT rows in the table — plus a tab-split per row per ASSET CLASS, because
 * the theme filter deciding which leg a row belongs to is per class and
 * `deriveGdeltAggregate` stays a pure function of (rows, spec). The read is
 * shared across the legs (`SharedBarRead`); the parse is not, and both are
 * kept off a per-poll cadence by the bar guard — twelve polls an hour at the
 * shipped 5-minute cadence (`DEFAULT_GDELT_POLL_INTERVAL_MS`).
 *
 * ## Cadence, and why the window end is the debate bar
 *
 * `windowEnd` is `floorToBar(now)`, the same grid `getContext` windows on
 * (#782). Both windows sit strictly before it, so the derivation reads only
 * CLOSED time: two polls inside one bar see the same rows and derive the same
 * item, whose id is a function of (source, class, window end) — so the store's
 * id dedupe makes the repeat a no-op rather than a second vote on the same
 * hour. The guard makes it free as well as harmless.
 *
 * ACROSS bars the id differs, so the store accumulates one item per bar and
 * the dedupe cannot help: `getContext` serves only the latest class-wide item
 * per (source, entity, type) for that reason, and `index.ts` carries the
 * argument. A day of these is a day of restatements of one trailing
 * statistic, not a day of independent evidence.
 *
 * A REFUSAL does not set the guard, deliberately: the reason a refusal is
 * usually a cold or gapped archive, and the next poll may be the one that
 * fills it.
 */

// The bar grid, from its one defining module — `index.ts` in this directory
// imports it the same way and states why the barrel is bypassed.
import {
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
} from '../../pipeline/debate-engine/debate-log-store.js';
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

/** The archive `source` key this pass reads. Same constant `GdeltIngestAgent` writes under. */
const SOURCE_GDELT = MI_SOURCES.gdeltGkg;

/** Refuse loudly once, then every Nth consecutive poll — `mi-coverage.ts`'s `shouldAlertAt` convention. */
export const REFUSAL_LOG_AFTER_CONSECUTIVE = 1;

/**
 * How many further consecutive refusals pass before the log repeats.
 *
 * Counted in POLLS, not wall-clock, so its span tracks
 * `gdeltPollIntervalMs` — at the shipped 5-minute default
 * (`DEFAULT_GDELT_POLL_INTERVAL_MS`) thirty-six polls is three hours. That is
 * long enough that a cold archive filling on its own (24 hours = 288 polls)
 * reports eight times rather than 288, short enough that a gap nobody is
 * watching still surfaces within a session.
 */
export const REFUSAL_REPEAT_EVERY = 36;

export function shouldLogRefusalAt(consecutive: number): boolean {
  if (consecutive < REFUSAL_LOG_AFTER_CONSECUTIVE) return false;
  return (consecutive - REFUSAL_LOG_AFTER_CONSECUTIVE) % REFUSAL_REPEAT_EVERY === 0;
}

/** A coverage refusal is an ingestion problem; a quiet hour is the world being quiet. */
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

/**
 * The per-bar work every asset class shares, resolved at most once per `run`.
 *
 * `windowEnd` and the archive slice behind it are functions of (source, bar,
 * windows) alone — identical for every leg — so a two-class run must pay one
 * clock read and one ~20,000-row archive read per bar, not two of each.
 *
 * Both are thunks rather than values because `run` must never throw: a closed
 * store or a throwing clock has to surface inside the PER-CLASS catch, not
 * above the loop where it would take the whole poll down. Neither memoizes a
 * throw, so one leg's failed read still leaves the other leg its own attempt,
 * exactly as when each leg read for itself.
 */
interface SharedBarRead {
  windows: GdeltWindows;
  end: () => Date;
  rows: () => readonly RawArchiveRow[];
}

export interface GdeltScoringPassDeps {
  archive: MiArchiveStore;
  store: MarketIntelligenceStore;
  clock: Clock;
  /** Which legs to derive for — the universe's asset classes, not every class that exists. */
  assetClasses: readonly AssetClass[];
  logger?: Logger | undefined;
  /** Overridable so a re-derivation over existing history can change the windows (#556 point 3). */
  windows?: GdeltWindows | undefined;
}

export class GdeltScoringPass {
  /** The debate bar each asset class last EMITTED for; a refusal leaves it unmoved. */
  readonly #emittedBar = new Map<AssetClass, number>();
  /** Consecutive refusals per asset class, reset by an emit or by a change of reason. */
  readonly #refusals = new Map<AssetClass, { reason: GdeltRefusalReason; consecutive: number }>();

  constructor(private readonly deps: GdeltScoringPassDeps) {}

  /** Logs, absorbing a throw from the logger itself — `gdelt-ingest-agent.ts` has the argument. */
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

  /**
   * Derives and ingests one aggregate per asset class for the current bar.
   *
   * **Never throws.** `production.ts` drives this from a timer callback, where
   * an escaped throw is an unhandled rejection in a process meant to run
   * unattended for fourteen days — and the two things it does (a SQLite read
   * against a store shutdown may have closed, a clock read) are exactly the
   * pair `gdelt-ingest-agent.ts` had to pull inside a catch for #713.
   * Synchronous for the same reason it is safe to call from there: both halves
   * are synchronous already, so there is no promise to leave unhandled.
   */
  run(trace_id = 'gdelt-scoring'): void {
    const bar = this.sharedBarRead();
    for (const asset_class of this.deps.assetClasses) {
      try {
        this.derive(trace_id, asset_class, bar);
      } catch (error) {
        // Per class, not around the loop: one leg's failure must not silently
        // cost the other leg its aggregate.
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

  /** One bar's shared clock read and archive slice, each resolved on first use. */
  private sharedBarRead(): SharedBarRead {
    const windows = this.deps.windows ?? DEFAULT_GDELT_WINDOWS;
    let windowEnd: Date | undefined;
    let rows: readonly RawArchiveRow[] | undefined;

    // Memoized rather than re-read per class for a second reason beyond the
    // cost: a loop that read the clock twice could straddle a bar boundary and
    // derive the two legs against different windows.
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
    // Strictly before `bar.rows()`: a bar every class has already emitted for
    // must cost no archive read at all, which only holds while this guard
    // returns ahead of the first row read.
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
