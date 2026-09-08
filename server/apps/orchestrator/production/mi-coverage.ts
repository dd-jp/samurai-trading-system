/**
 * Market-intelligence coverage measurement (#752) — per-name and per-subclass
 * `NO_DATA` counters, plus a loud degraded-coverage alert. See
 * docs/specs/market-intelligence-spec.md "Coverage is measured per name and
 * per subclass — and never gated on" (2026-08-16).
 *
 * ## Why an alert and not a refusal
 *
 * An earlier draft of this ticket proposed refusing to start on a coverage
 * hole. The spec states fail-open four times and is explicit that "the
 * expected steady state of this stage is an empty item list, and empty is the
 * correct answer" — a refusal would contradict a repeatedly-stated design
 * rather than fill a gap, and a system that will not start on a data gap
 * trades nothing on exactly the days coverage is patchy. `checkMiCoverage`
 * below never throws and never returns a value the caller could use to halt
 * the tick — the whole surface is "record it, tell someone, keep going".
 *
 * ## The premise this was built against
 *
 * #625 measured the stocks conviction ceiling at 0.5478 against a 0.55 floor
 * when a mute analyst dragged the evidence average down. `computeEvidenceStrength`
 * (`debate-engine/conviction-score.ts`) now EXCLUDES a mute analyst from that
 * average instead — see `conviction-score.test.ts`'s
 * "two live analysts and one mute one" case, which measures the fix directly.
 * That closes the failure a refusal would have existed to prevent, which is
 * why this module is a counter and an alert, not a gate.
 *
 * ## Coverage reads presence, never direction
 *
 * ADR-0016 D2 rules out catalyst-gating and the debate is what decides
 * direction. `hasCoverageFor` below asks only "does any scored item exist for
 * this name in the window" — it never inspects `sentiment`, so a pool of
 * uniformly bearish items reads as covered, exactly like a bullish one.
 *
 * ## Per-subclass, and what an absent subclass means
 *
 * `#739` added `UniverseInstrument.subclass`, but `DEFAULT_UNIVERSE` declares
 * none — `subclassOfUniverse(DEFAULT_UNIVERSE)` is `{}` until the pool file
 * (#749) lands. A per-subclass counter that silently dropped an unclassified
 * name, or reported an empty subclass breakdown that reads as full coverage,
 * would be the exact failure this ticket exists to prevent. So an instrument
 * with no declared subclass is bucketed under `UNCLASSIFIED_SUBCLASS`
 * explicitly, never dropped and never left to read as healthy.
 */
import type { MarketContext } from '../../../providers/market-intelligence/index.js';
import { resolveMiSubject } from '../../../providers/universe-pool/index.js';
import type { AssetClass, InstrumentSubclass, Logger } from '../../../shared/index.js';

/** The bucket a per-subclass counter uses when the universe declares no subclass for a name. */
export const UNCLASSIFIED_SUBCLASS = 'unclassified' as const;

/** Every bucket a per-subclass counter can report — the pool-file subclasses, plus the sentinel above. */
export type CoverageSubclass = InstrumentSubclass | typeof UNCLASSIFIED_SUBCLASS;

/** `instrument -> subclass`, or `UNCLASSIFIED_SUBCLASS` when the universe declares none. */
export function subclassFor(
  instrument: string,
  subclassOf: Readonly<Record<string, InstrumentSubclass>>,
): CoverageSubclass {
  return subclassOf[instrument] ?? UNCLASSIFIED_SUBCLASS;
}

/**
 * The lookback the coverage check reads against — the same 24h window
 * `fundamental`/`sentiment` already query `MarketIntelligenceStore` with
 * (`MI_CONTEXT_WINDOW_MS` in each analyst), so "no scored item inside the
 * staleness window" means the same window the debate itself sees, not a
 * separately-tunable number a coverage check and the analysts could disagree
 * about.
 */
export const COVERAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The counter name behind every `MiCoverageTelemetry.noDataObserved` call, keyed by instrument. */
export const MI_NO_DATA_BY_NAME_COUNTER = 'mi_no_data_by_name';
/** The counter name behind every `MiCoverageTelemetry.noDataObserved` call, keyed by subclass. */
export const MI_NO_DATA_BY_SUBCLASS_COUNTER = 'mi_no_data_by_subclass';

/** One instrument's coverage check, at one tick, that came back empty. */
export interface MiCoverageEvent {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  subclass: CoverageSubclass;
  reported_at: Date;
}

/**
 * Where the per-name/per-subclass `NO_DATA` counters go. Fires only on a
 * MISS — same convention as `AnalystTelemetry.indicatorUnavailable`
 * (`INDICATOR_UNAVAILABLE_COUNTER`): the log stream is the metric store here,
 * and a rate is a scrape dividing this count by the tick count recorded
 * elsewhere, not a value this port computes.
 */
export interface MiCoverageTelemetry {
  noDataObserved(event: MiCoverageEvent): void;
}

/**
 * A coverage alert for one instrument, naming it and its subclass.
 *
 * Carries `trace_id` explicitly, the same way `MiCoverageEvent` above does —
 * `checkMiCoverage` already holds `params.trace_id` at both call sites, so
 * this is the "remains the preferred form" case `trace-context.ts` describes,
 * not the ambient-fallback one (#1280).
 */
export interface MiCoverageAlert {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  subclass: CoverageSubclass;
  reported_at: Date;
}

/**
 * Where the degraded-coverage alert goes. Declared beside its caller, the
 * same convention as `AnalystSkipAlertChannel` (analysts-adapter.ts) and
 * `TraderDiagnosticAlertChannel` (trader-diagnostic-alert.ts).
 */
export interface MiCoverageAlertChannel {
  postCoverageAlert(alert: MiCoverageAlert): Promise<void>;
}

/** The one method the coverage check calls on `MarketIntelligenceStore`. */
export interface MiCoverageContextSource {
  getContext(assetClass: AssetClass, timeWindowMs: number, trace_id: string): MarketContext;
}

/**
 * Presence, never direction (spec: "Coverage, never direction"). An item
 * counts as covering `instrument` when its `entity` matches, regardless of
 * `sentiment` — a pool of uniformly bearish items must not read as absent.
 */
export function hasCoverageFor(context: MarketContext, instrument: string): boolean {
  return (
    context.news.some((item) => item.entity === instrument) ||
    context.social.some((item) => item.entity === instrument)
  );
}

/** Alert on the first miss, like `TraderDiagnosticThrottle` (#698) — every kind here is a gap that should not persist. */
export const ALERT_AFTER_CONSECUTIVE_NO_DATA = 1;

/**
 * How often the alert repeats while the gap persists, counted in further
 * consecutive misses after the first alert — same bounded-repeat convention
 * as `ALERT_REPEAT_EVERY_SKIPS`/`ALERT_REPEAT_EVERY_DIAGNOSTICS`: loud once,
 * not flooding the escalation chat every tick.
 */
export const ALERT_REPEAT_EVERY_NO_DATA = 8;

function shouldAlertAt(consecutive: number): boolean {
  if (consecutive < ALERT_AFTER_CONSECUTIVE_NO_DATA) return false;
  return (consecutive - ALERT_AFTER_CONSECUTIVE_NO_DATA) % ALERT_REPEAT_EVERY_NO_DATA === 0;
}

/**
 * Per-instrument coverage state for one running orchestrator (#752). In
 * memory and restart-clean, the same posture `consecutiveSkips`
 * (analysts-adapter.ts) and `TraderDiagnosticThrottle` (#698) take: a process
 * that just restarted has no evidence about the previous process's ticks,
 * and a crash is already alarmed by the heartbeat's silence.
 *
 * `degraded` is the flag the run carries — true whenever ANY instrument this
 * monitor has observed is CURRENTLY missing coverage, false the instant every
 * observed instrument has a scored item again. It is a live read of monitor
 * state, not a latch: a run that recovers coverage is not "degraded"
 * forever, matching the fail-open posture — the flag exists to be SEEN, not
 * to gate anything.
 *
 * `everDegraded` answers a different question, and end-of-run reporting
 * needs both: a soak whose coverage hole opened and closed hours before
 * teardown reads `degraded === false` at the moment anything inspects it —
 * correctly, "nothing is wrong right now" — but a report built only from the
 * live flag would say the run was never degraded, which is false and is
 * exactly the gap AC2 exists to close. `everDegraded` latches true on the
 * first miss and never clears; it is the "did this run ever have a hole"
 * answer, `degraded` is the "does it have one right now" answer.
 */
export class MiCoverageMonitor {
  readonly #consecutive = new Map<string, number>();
  readonly #currentlyMissing = new Set<string>();
  #everDegraded = false;

  /** True while at least one observed instrument currently has no coverage. */
  get degraded(): boolean {
    return this.#currentlyMissing.size > 0;
  }

  /** True if ANY instrument this monitor has observed EVER missed coverage, even if fully recovered since. Never clears. */
  get everDegraded(): boolean {
    return this.#everDegraded;
  }

  /** The instruments currently missing coverage, for a diagnostic read (not used to gate anything). */
  get missingInstruments(): readonly string[] {
    return Array.from(this.#currentlyMissing);
  }

  /**
   * Records this tick's coverage observation for one instrument and reports
   * whether an alert is due. A single good tick clears the run — the same
   * "intermittent failure must not accumulate its way to an alert" rule
   * `consecutiveSkips` applies (analysts-adapter.ts).
   */
  observe(instrument: string, covered: boolean): { alert: boolean; consecutive: number } {
    if (covered) {
      this.#consecutive.delete(instrument);
      this.#currentlyMissing.delete(instrument);
      return { alert: false, consecutive: 0 };
    }

    const consecutive = (this.#consecutive.get(instrument) ?? 0) + 1;
    this.#consecutive.set(instrument, consecutive);
    this.#currentlyMissing.add(instrument);
    this.#everDegraded = true;
    return { alert: shouldAlertAt(consecutive), consecutive };
  }
}

export interface CheckMiCoverageDeps {
  contextSource: MiCoverageContextSource;
  subclassOf: Readonly<Record<string, InstrumentSubclass>>;
  telemetry: MiCoverageTelemetry;
  monitor: MiCoverageMonitor;
  alertChannel: MiCoverageAlertChannel | undefined;
  logger: Logger | undefined;
  /**
   * Whether MI has finished looking at this instrument at least once in this
   * process (#1085). While it answers `false`, `telemetry.noDataObserved` still
   * fires — the no-data RATE keeps its true denominator — but the instrument
   * never reaches `monitor.observe`, so `MiCoverageMonitor`'s consecutive-miss
   * counter does NOT advance and no alert is raised. Two different counters:
   * the telemetry one moves, the monitor's does not.
   *
   * Needed because the refresh is now queued rather than awaited
   * (`MiRefreshQueue`): a name whose only items would have come from this
   * tick's own refresh reads uncovered at analyst time, and with
   * `ALERT_AFTER_CONSECUTIVE_NO_DATA = 1` that is an alert on tick 1 for a
   * name that does have news. Hydration covers the restart case — `hydrate()`
   * replays the archive into the store at boot, so any name with news inside
   * `COVERAGE_WINDOW_MS` reads covered before a single refresh runs — but it
   * cannot cover a FRESH archive, which is exactly where the spurious alert
   * would land.
   *
   * ATTEMPTED, not succeeded: a refresh that failed or was refused by the
   * spend cap has no data and is not going to get any, so it must alert. The
   * gate therefore holds for at most the few ticks between the first request
   * and the first completed sweep, and cannot silence coverage for a run.
   *
   * Absent means no gate, which is the honest default for a caller with no MI
   * writer wired at all: nothing will ever look, so the first miss should
   * alert immediately.
   */
  refreshAttempted?: ((instrument: string) => boolean) | undefined;
}

export interface CheckMiCoverageParams {
  trace_id: string;
  instrument: string;
  assetClass: AssetClass;
  reportedAt: Date;
}

/**
 * The tick-boundary check (#752): reads whether `instrument` has any scored
 * item in the staleness window, records the per-name/per-subclass counter on
 * a miss, and posts the degraded-coverage alert when the monitor says one is
 * due.
 *
 * **Never throws and never blocks the tick.** `deps.contextSource.getContext`
 * is a synchronous in-memory read (`MarketIntelligenceStore`, same contract
 * every analyst already calls) so nothing here awaits a vendor; the one
 * awaited call is the alert POST, and a failed alert is caught and logged —
 * the tick has already produced its answer by the time this runs, and an
 * undelivered alert must not turn "coverage is thin" into "the orchestrator
 * threw" (same posture as `postSkipAlert`, analysts-adapter.ts).
 */
export async function checkMiCoverage(
  deps: CheckMiCoverageDeps,
  params: CheckMiCoverageParams,
): Promise<void> {
  const context = deps.contextSource.getContext(
    params.assetClass,
    COVERAGE_WINDOW_MS,
    params.trace_id,
  );
  // #914/#960: ingestion now files items under the resolved MI subject
  // (`resolveMiSubject` — the US underlying for an LSE-listed leveraged ETP,
  // identity for every non-pool instrument), so coverage must ask the same
  // question the analysts now ask, or an LSE row would read as permanently
  // uncovered even when its underlying has fresh items — the wrong instrument
  // compared to the right entity.
  const covered = hasCoverageFor(context, resolveMiSubject(params.instrument));
  const subclass = subclassFor(params.instrument, deps.subclassOf);

  // ALWAYS, whatever the refresh timing is (#1085): the counter is the
  // measurement, and a rate whose denominator silently dropped the ticks
  // before MI's first sweep would be the wrong number, not a quieter one.
  if (!covered) {
    deps.telemetry.noDataObserved({
      trace_id: params.trace_id,
      instrument: params.instrument,
      asset_class: params.assetClass,
      subclass,
      reported_at: params.reportedAt,
    });
  }

  // #1085: the alert machinery, not the measurement, is what a queued refresh
  // makes spurious — so the gate is here, ABOVE `observe`, rather than on the
  // alert branch below. Gating the branch alone would let the suppressed miss
  // still advance the consecutive counter, and `shouldAlertAt` would then skip
  // the next 8 misses before speaking: a gap meant to hold one tick would
  // silence the first real one. Not observing at all leaves the run's
  // `degraded`/`everDegraded` flags saying what they should — "MI has not
  // looked yet" is not "this name has no coverage".
  if (deps.refreshAttempted?.(params.instrument) === false) return;

  const { alert } = deps.monitor.observe(params.instrument, covered);
  if (!alert) return;

  try {
    await deps.alertChannel?.postCoverageAlert({
      trace_id: params.trace_id,
      instrument: params.instrument,
      asset_class: params.assetClass,
      subclass,
      reported_at: params.reportedAt,
    });
  } catch (error) {
    deps.logger?.log({
      trace_id: params.trace_id,
      stage: 'analysts',
      event: 'mi_coverage_alert_send_failed',
      level: 'error',
      message:
        `market-intelligence coverage alert could not be delivered for ${params.instrument} — ` +
        'coverage is still missing and nobody has been told',
      payload: {
        instrument: params.instrument,
        subclass,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
