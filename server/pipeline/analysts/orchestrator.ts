/**
 * Analyst Orchestrator (ticket #71) — see docs/specs/analysts-spec.md
 * "Module: Analyst Orchestrator". Fans a Signal out across every applicable
 * persona (Technical + Sentiment for crypto; Technical + Fundamental +
 * Sentiment for stocks, per `Analyst.applies_to`) and enforces the
 * role-dependent quorum: a mandatory persona failing blocks the whole tick
 * (analysts-spec.md story 21, "no stale fallback"), an optional persona
 * failing just shrinks the set (story 22).
 *
 * Retry-on-failure is built here as of #431 (analysts-spec.md "Module:
 * Failure Handling", story 19): one bounded retry with a short timeout for
 * any failing persona, regardless of role. The other half of that module —
 * the 2-consecutive-skip alert (story 25) — lives one level up in
 * `buildAnalystsStep`, which is where the tick boundary and the alert
 * transport both are.
 *
 * `analysts()` is the exact `TickSteps.analysts` shape (orchestrator/types.ts:
 * `(input: { trace_id, signal, clock }) => Promise<AnalystView[]>`), so an
 * instance can be bound directly into the tick chain once Market Data /
 * Market Intelligence instances exist at composition time. An empty array is
 * how the tick runner already recognizes a quorum skip (tick-runner.ts).
 */

import {
  AlwaysOpenCalendar,
  type MarketDataService,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock } from '../../shared/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import { technicalAnalyst } from './technical-analyst.js';
import type {
  Analyst,
  AnalystFailure,
  AnalystRunResult,
  AnalystTelemetry,
  Signal,
} from './types.js';
import { NOOP_ANALYST_TELEMETRY } from './types.js';

const ALL_PERSONAS: Analyst[] = [technicalAnalyst, fundamentalAnalyst, sentimentAnalyst];

/**
 * The "short timeout" of analysts-spec.md story 19, as a number.
 *
 * Sized against what a persona actually waits on, which is market data over
 * HTTP, not an LLM: the personas are mechanical (technical reads indicators,
 * fundamental returns a constant, sentiment reads an in-memory store). 10s is
 * generous for that and still an order of magnitude under the 15-minute tick
 * cadence of ADR-0008, so a hung upstream costs one tick's freshness rather
 * than wedging the scheduler.
 *
 * The point of having a timeout at all is that `Promise.all` below has no
 * deadline of its own: one persona whose fetch never settles hangs the whole
 * analyst stage forever, and an unattended run has nobody to notice.
 */
export const DEFAULT_ANALYST_TIMEOUT_MS = 10_000;

/** analysts-spec.md story 19: exactly one retry, so a blip is absorbed without a retry storm. */
const ATTEMPTS_PER_PERSONA = 2;

export interface AnalystOrchestratorDeps {
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
  /**
   * Per-asset-class trading calendars (#746), threaded straight onto every
   * `AnalystInput` below — this class does not itself compute anything from
   * them, only resolves `signal.asset_class` to the right one.
   *
   * Optional and defaults to a pair of `AlwaysOpenCalendar`s: the SAFE
   * default is "no session to anchor to" for every asset class
   * (`session-features.ts` reads that as a real `null`, never a fabricated
   * value), not a guessed-at real calendar a caller happened not to supply.
   * `production.ts` already resolves the real pair for the flatten rule
   * (`sessionCalendars`, ADR-0014) and reuses it here rather than deriving a
   * second one — a second derivation inherits bugs independently of the
   * first, exactly what #696 found for `UsEquityRegularHoursCalendar`.
   * `production.test.ts` asserts the composition root supplies the real pair,
   * mirroring the #745 telemetry-wiring test for the same defect class (a
   * mechanism nothing calls).
   */
  sessionCalendars?: Record<AssetClass, TradingCalendar>;
  /**
   * Where an analyst's counters go (#745). Threaded straight onto every
   * `AnalystInput` below — this class neither reads nor aggregates it, because
   * the counter is per-read and this layer only sees per-persona outcomes.
   * Optional here (tests and the backtest omit it); `production.ts` supplies
   * the real sink. `AnalystInput.telemetry` itself is non-optional (#790), so
   * a missing dep falls back to `NOOP_ANALYST_TELEMETRY` rather than the
   * field going missing on the input every persona receives.
   */
  telemetry?: AnalystTelemetry;
}

/** The safe default for `AnalystOrchestratorDeps.sessionCalendars` — see its doc comment. */
function defaultSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return {
    crypto: new AlwaysOpenCalendar(),
    stocks: new AlwaysOpenCalendar(),
  };
}

export interface AnalystOrchestratorOptions {
  /** Per-attempt deadline. Defaults to `DEFAULT_ANALYST_TIMEOUT_MS`. */
  timeout_ms?: number;
}

/** Marker for the timeout path, so the logged reason names it as a timeout rather than an error. */
class AnalystTimeoutError extends Error {
  constructor(analyst_type: string, timeout_ms: number) {
    super(`${analyst_type} did not answer within ${timeout_ms}ms`);
    this.name = 'AnalystTimeoutError';
  }
}

/**
 * Races `work` against a deadline. The timer is always cleared: an uncleared
 * `setTimeout` keeps the Node event loop alive, which in a 15-minute-cadence
 * process means a run that will not exit for as long as the longest timeout it
 * ever armed.
 *
 * A timed-out attempt's promise keeps running in the background — there is no
 * `AbortSignal` on the `Analyst` port to cancel it with. That is acceptable
 * here and deliberately not papered over: the personas have no side effects,
 * so a late arrival is discarded, not applied.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeout_ms: number,
  analyst_type: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AnalystTimeoutError(analyst_type, timeout_ms)),
          timeout_ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class AnalystOrchestrator {
  private readonly timeoutMs: number;
  private readonly sessionCalendars: Record<AssetClass, TradingCalendar>;

  constructor(
    private readonly deps: AnalystOrchestratorDeps,
    private readonly personas: Analyst[] = ALL_PERSONAS,
    options: AnalystOrchestratorOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_ANALYST_TIMEOUT_MS;
    this.sessionCalendars = deps.sessionCalendars ?? defaultSessionCalendars();
  }

  /**
   * The `analyst_id`s this instance's personas emit views under (#371) — what
   * the composition root seeds `analyst_weights` with, so the Feedback Loop's
   * daily cycle has a row to step for every analyst that can appear in a
   * debate log.
   *
   * Derived from `analyst_type` because that is the only identity the
   * `Analyst` port carries, and every persona emits it verbatim as its view's
   * `analyst_id` (pinned in orchestrator.test.ts — the seeder is wrong the
   * moment those two diverge, and it would be wrong silently: `runDailyCycle`
   * would go back to skipping the analyst it could not find a row for).
   *
   * Every persona, not just the ones applicable to the configured asset
   * class: applicability is per-signal (`applies_to`), and a run whose
   * universe later gains a stock must not need a re-seed to attribute the
   * fundamental analyst.
   */
  analystIds(): string[] {
    return [...new Set(this.personas.map((persona) => persona.analyst_type))];
  }

  /**
   * Runs every applicable persona in parallel and enforces the
   * role-dependent quorum. Returns the full breakdown (failures included)
   * for callers that need more than the bare view list.
   */
  async runAnalysts(trace_id: string, signal: Signal, clock: Clock): Promise<AnalystRunResult> {
    const applicable = this.personas.filter((persona) => persona.applies_to(signal.asset_class));
    const analyst_count = applicable.length;

    const outcomes = await Promise.all(
      applicable.map(async (persona) => {
        // One bounded retry, uniform across roles (analysts-spec.md story 19).
        // Every failure mode funnels through here identically — timeout, thrown
        // error, or malformed output surfacing as a throw — differing only in
        // the reason string (story 20).
        let lastReason = '';
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PERSONA; attempt++) {
          try {
            const view = await withTimeout(
              persona.run({
                trace_id,
                signal,
                clock,
                market_intelligence: this.deps.market_intelligence,
                market_data: this.deps.market_data,
                calendar: this.sessionCalendars[signal.asset_class],
                telemetry: this.deps.telemetry ?? NOOP_ANALYST_TELEMETRY,
              }),
              this.timeoutMs,
              persona.analyst_type,
            );
            return { persona, status: 'fulfilled' as const, view };
          } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
          }
        }
        // The reason says the retry happened, so a log line cannot be read as
        // "failed once" when the persona actually failed twice.
        return {
          persona,
          status: 'rejected' as const,
          reason: `${lastReason} (after ${ATTEMPTS_PER_PERSONA} attempts)`,
        };
      }),
    );

    const views: AnalystView[] = [];
    const failures: AnalystFailure[] = [];
    let mandatoryFailed = false;

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        views.push(outcome.view);
        continue;
      }
      failures.push({
        analyst_type: outcome.persona.analyst_type,
        role: outcome.persona.role,
        reason: outcome.reason,
      });
      if (outcome.persona.role === 'mandatory') {
        mandatoryFailed = true;
      }
    }

    return {
      views: mandatoryFailed ? [] : views,
      analyst_count,
      skipped: mandatoryFailed,
      failures,
    };
  }

  /** The exact `TickSteps.analysts` shape (orchestrator/types.ts) — empty array = quorum skip. */
  async analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
  }): Promise<AnalystView[]> {
    const result = await this.runAnalysts(input.trace_id, input.signal, input.clock);
    return result.views;
  }
}
