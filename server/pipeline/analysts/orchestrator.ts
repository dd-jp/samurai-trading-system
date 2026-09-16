/**
 * Analyst Orchestrator — fans a Signal out across every applicable persona
 * (Technical + Fundamental + Sentiment; equities only, per
 * `Analyst.applies_to`) and enforces the role-dependent quorum: a mandatory
 * persona failing blocks the whole tick ("no stale fallback"), an optional
 * persona failing just shrinks the set.
 *
 * One bounded retry with a short timeout applies to any failing persona,
 * regardless of role. The 2-consecutive-skip alert lives one level up in
 * `buildAnalystsStep`, which owns the tick boundary and the alert transport.
 *
 * `analysts()` is the exact `TickSteps.analysts` shape (orchestrator/types.ts),
 * so an instance can be bound directly into the tick chain. An empty array
 * is how the tick runner recognizes a quorum skip (tick-runner.ts).
 */

import {
  AlwaysOpenCalendar,
  type MarketDataService,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock, Logger } from '../../shared/index.js';
import {
  describeThrown,
  MAX_ERROR_BODY_CHARS,
  maskAndCap,
  safeLog,
  sanitizeLogText,
} from '../../shared/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { classifyFailureCause } from '../debate-engine/index.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import { technicalAnalyst } from './technical-analyst.js';
import type {
  Analyst,
  AnalystFailure,
  AnalystFailureKind,
  AnalystRunResult,
  AnalystTelemetry,
  Signal,
} from './types.js';
import { NOOP_ANALYST_TELEMETRY } from './types.js';

const ALL_PERSONAS: Analyst[] = [technicalAnalyst, fundamentalAnalyst, sentimentAnalyst];

/**
 * What a persona waits on is market data over HTTP, not an LLM (the
 * personas are mechanical), and specifically the QUEUE in front of that
 * HTTP: bar fetches take `acquireBackground()` on the Alpaca token bucket
 * shared with the order path, which refills at 2.0/s, while one sweep of
 * the universe reaches the venue for up to four windows per instrument at
 * warm-store steady state. A first-ever tick against an empty store reaches
 * the venue for more and is not covered here — warm the store at boot
 * instead of widening this number.
 *
 * 30,000ms is that drain, derived rather than chosen: `(20 instruments *
 * 4 windows - 20 tokens of headroom) / 2.0 per second`, pinned from the
 * pacing side by `production/rate-limit-wiring.test.ts`. The two
 * `ATTEMPTS_PER_PERSONA` retries may be waiting on the SAME fetch: the
 * retry carries no `AbortSignal`, so attempt 2 joins attempt 1's
 * still-in-flight request via `MarketDataServiceImpl.inFlightBarFetches`
 * instead of re-asking the venue — the right trade against a queue;
 * liveness against a genuinely stuck fetch comes from `fetchWithTimeout`.
 *
 * The point of a timeout at all: `Promise.all` below has no deadline of its
 * own, so one persona whose fetch never settles hangs the whole stage.
 *
 * There is no enclosing analyst-stage budget this divides out of, and that
 * is deliberate — unlike the debate arm's per-attempt timeout, which IS a
 * division of `LATENCY_BUDGET_MS`. Nothing downstream measures the analyst
 * stage's wall clock, so `ANALYST_STAGE_WALL_CLOCK_MS` below is an OUTPUT
 * of this sizing, not a ceiling imposed on it.
 */
/**
 * This literal is `deriveAnalystDrainMs`'s DRAIN term alone
 * (`server/shared/http/venue-pacing.ts`), not the full `deriveAnalystTimeoutMs`
 * a real deployment runs — that also floors at a fetch-bound term, so the
 * true per-attempt deadline at even the checked-in Alpaca defaults is
 * already ~60,750ms, not this 30,000ms. Kept a static fallback ON PURPOSE:
 * it is what a caller gets who constructs `AnalystOrchestrator` directly
 * without an explicit `timeout_ms` (tests, offline paths), and what
 * `ANALYST_STAGE_WALL_CLOCK_MS` below and `paper-profile.ts`'s
 * pass-duration tripwire comments are sized against. An operator relying on
 * this figure as a true ceiling must re-run `deriveAnalystTimeoutMs`
 * against the RESOLVED pacing by hand.
 */
export const DEFAULT_ANALYST_TIMEOUT_MS = 30_000;

/** analysts-spec.md story 19: exactly one retry, so a blip is absorbed without a retry storm */
const ATTEMPTS_PER_PERSONA = 2;

/**
 * The analyst stage's worst-case wall clock. Exact rather than an upper
 * bound, because `runAnalysts` fans the personas out under one
 * `Promise.all`: the stage settles when the slowest persona does, and the
 * slowest possible persona exhausts every attempt. Pinned behaviourally by
 * `analyst-stage-wall-clock.test.ts` so a change to the fan-out shape or the
 * attempt count cannot leave this constant describing code that no longer
 * exists. Inherits `DEFAULT_ANALYST_TIMEOUT_MS`'s staleness — see that
 * constant's doc comment.
 */
export const ANALYST_STAGE_WALL_CLOCK_MS = ATTEMPTS_PER_PERSONA * DEFAULT_ANALYST_TIMEOUT_MS;

export interface AnalystOrchestratorDeps {
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
  /**
   * Per-asset-class trading calendars, threaded straight onto every
   * `AnalystInput` below — this class only resolves `signal.asset_class` to
   * the right one, it computes nothing from them.
   *
   * Optional and defaults to a pair of `AlwaysOpenCalendar`s: the SAFE
   * default is "no session to anchor to" for every asset class
   * (`session-features.ts` reads that as a real `null`, never a fabricated
   * value), not a guessed-at real calendar a caller happened not to supply.
   * `production.ts` reuses its own resolved pair here rather than deriving
   * a second one — a second derivation inherits bugs independently of the
   * first.
   */
  sessionCalendars?: Record<AssetClass, TradingCalendar>;
  /**
   * Where an analyst's counters go. Threaded straight onto every
   * `AnalystInput` below — this class neither reads nor aggregates it, since
   * the counter is per-read and this layer only sees per-persona outcomes.
   * Optional here (tests and the backtest omit it); `production.ts` supplies
   * the real sink, falling back to `NOOP_ANALYST_TELEMETRY` since
   * `AnalystInput.telemetry` itself is non-optional.
   */
  telemetry?: AnalystTelemetry;
  /**
   * Where the cause behind a stage failure goes. Optional here, with a safe
   * no-op default (`NOOP_LOGGER`), so a caller that omits it gets silence,
   * not a crash, and `production.ts` wires the real one.
   */
  logger?: Logger;
}

/** The safe default for `AnalystOrchestratorDeps.sessionCalendars` — see its doc comment */
function defaultSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return {
    crypto: new AlwaysOpenCalendar(),
    stocks: new AlwaysOpenCalendar(),
  };
}

/** The safe default for `AnalystOrchestratorDeps.logger` — see its doc comment */
const NOOP_LOGGER: Logger = {
  log(): void {
    // Intentionally does nothing — same posture as `NOOP_ANALYST_TELEMETRY`:
    // a missing logger must never be able to fail a tick
  },
};

/**
 * Renders a caught value's name, message, stack and cause into a bounded,
 * credential-safe payload. `describeThrown` alone collapses an `Error` to
 * its `.message`, losing the ability to tell an HTTP timeout from a 429
 * from a malformed body — this keeps `name`/`stack`/`cause` too, masked and
 * capped the same way `analysts-adapter.ts` treats every other
 * upstream-controlled failure string.
 */
function renderErrorDetail(error: unknown): Record<string, unknown> {
  try {
    return renderErrorFields(error);
  } catch {
    // Guards the RENDER, which `safeLog` cannot: a hostile value's throwing
    // `toString`/`Symbol.toPrimitive` (or a lazy `message` getter) throws
    // while the payload is still being built, before `safeLog`'s own
    // try/catch is entered. On the late-settlement path the escape would
    // reject a derived promise nobody holds, which Node 22 turns into
    // process exit
    return { message: '[unrenderable error]' };
  }
}

/**
 * Per field, so one hostile getter costs only its own field: a thrown `stack`
 * must not take the `name`/`message`/`cause` that rendered fine down with it,
 * which is the whole diagnostic value of the line
 */
function renderField(render: () => string): string {
  try {
    return render();
  } catch {
    return '[unrenderable]';
  }
}

function renderErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: sanitizeLogText(describeThrown(error)) };
  }
  const detail: Record<string, unknown> = {
    name: renderField(() => sanitizeLogText(error.name)),
    message: renderField(() => sanitizeLogText(error.message)),
  };
  const stack = renderField(() =>
    typeof error.stack === 'string' ? maskAndCap(error.stack, MAX_ERROR_BODY_CHARS) : '',
  );
  if (stack !== '') detail.stack = stack;
  if (error.cause !== undefined) {
    detail.cause = renderField(() => sanitizeLogText(describeThrown(error.cause)));
  }
  return detail;
}

export interface AnalystOrchestratorOptions {
  /** Per-attempt deadline. Defaults to `DEFAULT_ANALYST_TIMEOUT_MS`. */
  timeout_ms?: number;
}

/**
 * Late-arrival observer for one persona attempt inside `withTimeout`: fires
 * strictly after the tick has already moved on from that attempt (it lost
 * the race to the deadline). Logged only — see `withTimeout`'s doc comment
 * for why "a late arrival is logged, never applied" holds structurally, not
 * by convention.
 */
function logLatePersonaSettlement(
  logger: Logger,
  trace_id: string,
  persona: Analyst,
  attempt: number,
  timeout_ms: number,
  outcome: { status: 'fulfilled'; value: AnalystView } | { status: 'rejected'; error: unknown },
): void {
  safeLog(logger, {
    trace_id,
    stage: 'analysts',
    level: 'debug',
    message:
      `analysts: ${persona.analyst_type} attempt ${attempt} settled after its ` +
      `${timeout_ms}ms deadline had already been reported as a timeout — the ` +
      `cause below, discarded rather than applied to this tick`,
    payload: {
      analyst_type: persona.analyst_type,
      attempt,
      outcome: outcome.status,
      ...(outcome.status === 'rejected' ? renderErrorDetail(outcome.error) : {}),
    },
  });
}

/**
 * Classifies one failed persona attempt into a reason string and failure
 * kind, and logs the non-timeout case: a genuine (non-timeout) rejection
 * already carries a full `Error` right here, and the caller's bookkeeping
 * collapses it to a bare reason string. Logged in addition to, never
 * instead of, the caller's own `reason`/`kind` bookkeeping and the
 * error/warn line `analysts-adapter.ts` builds from it.
 */
function classifyPersonaAttemptFailure(
  logger: Logger,
  trace_id: string,
  persona: Analyst,
  attempt: number,
  error: unknown,
): { reason: string; kind: AnalystFailureKind } {
  let reason: string;
  try {
    reason = describeThrown(error);
  } catch {
    // `describeThrown` can still throw for a value hostile enough to defeat
    // its own fallback ladder (a throwing `message` getter, or a `Proxy`
    // with a throwing `getPrototypeOf` trap). Left uncaught here it would
    // escape this catch — which exists to HANDLE the persona's failure —
    // and reject the `Promise.all` below, turning a handled analyst failure
    // into a failed tick before any of this loop's own logging runs
    reason = '[unrenderable error]';
  }
  // Named explicitly rather than left to the classifier: it is this
  // class's own deadline, not a provider's
  const kind: AnalystFailureKind =
    error instanceof AnalystTimeoutError ? 'timeout' : classifyFailureCause(error);
  if (kind !== 'timeout') {
    safeLog(logger, {
      trace_id,
      stage: 'analysts',
      level: 'debug',
      message: `analysts: ${persona.analyst_type} attempt ${attempt} rejected — cause below`,
      payload: {
        analyst_type: persona.analyst_type,
        attempt,
        ...renderErrorDetail(error),
      },
    });
  }
  return { reason, kind };
}

/** Marker for the timeout path, so the logged reason names it as a timeout rather than an error */
class AnalystTimeoutError extends Error {
  constructor(analyst_type: string, timeout_ms: number) {
    super(`${analyst_type} did not answer within ${timeout_ms}ms`);
    this.name = 'AnalystTimeoutError';
  }
}

/**
 * Races `work` against a deadline. The timer is always cleared: an
 * uncleared `setTimeout` keeps the Node event loop alive, which in a
 * 15-minute-cadence process means a run that will not exit for as long as
 * the longest timeout it ever armed.
 *
 * A timed-out attempt's promise keeps running in the background — there is
 * no `AbortSignal` on the `Analyst` port to cancel it with. That is
 * deliberate: the personas have no side effects, so a late arrival is
 * discarded, not applied. `onLateSettlement` is how that discarded arrival
 * is still OBSERVED — it fires at most once, only on the timeout branch,
 * logged by the caller, never fed back into this function's return value.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeout_ms: number,
  analyst_type: string,
  onLateSettlement?: (
    outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown },
  ) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reaching this callback means `work` genuinely has not settled
          // yet: a `work` that had already settled would have won the race
          // in an earlier microtask checkpoint, before this
          // macrotask-scheduled callback could run — so it's safe to attach
          // observers to `work` here, and only here (attaching eagerly at
          // call time would fire on every attempt, not just the abandoned
          // one). `Promise.race` already attaches its own handler to every
          // promise it's given, so a late rejection is handled-and-ignored
          // regardless; `onLateSettlement` only lets the caller observe it
          if (onLateSettlement !== undefined) {
            work.then(
              (value) => onLateSettlement({ status: 'fulfilled', value }),
              (error: unknown) => onLateSettlement({ status: 'rejected', error }),
            );
          }
          reject(new AnalystTimeoutError(analyst_type, timeout_ms));
        }, timeout_ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class AnalystOrchestrator {
  private readonly timeoutMs: number;
  private readonly sessionCalendars: Record<AssetClass, TradingCalendar>;
  private readonly logger: Logger;

  constructor(
    private readonly deps: AnalystOrchestratorDeps,
    private readonly personas: Analyst[] = ALL_PERSONAS,
    options: AnalystOrchestratorOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_ANALYST_TIMEOUT_MS;
    this.sessionCalendars = deps.sessionCalendars ?? defaultSessionCalendars();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * The `analyst_id`s this instance's personas emit views under — what the
   * composition root seeds `analyst_weights` with, so the Feedback Loop's
   * daily cycle has a row to step for every analyst that can appear in a
   * debate log.
   *
   * Derived from `analyst_type` because that is the only identity the
   * `Analyst` port carries, and every persona emits it verbatim as its
   * view's `analyst_id` (pinned in orchestrator.test.ts — if those two
   * diverge, `runDailyCycle` silently goes back to skipping the analyst it
   * cannot find a row for).
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
   *
   * `bar` is the claimed decision bar's opening boundary — the caller's
   * single derivation for this pass (`DecisionGate.claim`) — threaded onto
   * every `AnalystInput` below unchanged. This class does not derive a bar
   * of its own from `clock`; see `AnalystInput.bar`'s doc comment for why a
   * second derivation is exactly the defect this parameter exists to close.
   */
  async runAnalysts(
    trace_id: string,
    signal: Signal,
    clock: Clock,
    bar: Date,
  ): Promise<AnalystRunResult> {
    const applicable = this.personas.filter((persona) => persona.applies_to(signal.asset_class));
    const analyst_count = applicable.length;

    const outcomes = await Promise.all(
      applicable.map(async (persona) => {
        // One bounded retry, uniform across roles (analysts-spec.md story 19)
        // Every failure mode funnels through here identically — timeout, thrown
        // error, or malformed output surfacing as a throw — differing only in
        // the reason string (story 20)
        let lastReason = '';
        // The LAST attempt's kind, not a summary of both: a persona whose first
        // attempt threw and whose retry timed out is a timeout at the point the
        // stage gave up, which is the one the caller is deciding about
        let lastKind: AnalystFailureKind = 'other';
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PERSONA; attempt++) {
          try {
            const view = await withTimeout(
              persona.run({
                trace_id,
                signal,
                clock,
                bar,
                market_intelligence: this.deps.market_intelligence,
                market_data: this.deps.market_data,
                calendar: this.sessionCalendars[signal.asset_class],
                telemetry: this.deps.telemetry ?? NOOP_ANALYST_TELEMETRY,
              }),
              this.timeoutMs,
              persona.analyst_type,
              (outcome) =>
                logLatePersonaSettlement(
                  this.logger,
                  trace_id,
                  persona,
                  attempt,
                  this.timeoutMs,
                  outcome,
                ),
            );
            return { persona, status: 'fulfilled' as const, view };
          } catch (error) {
            ({ reason: lastReason, kind: lastKind } = classifyPersonaAttemptFailure(
              this.logger,
              trace_id,
              persona,
              attempt,
              error,
            ));
          }
        }
        // The reason says the retry happened, so a log line cannot be read as
        // "failed once" when the persona actually failed twice
        return {
          persona,
          status: 'rejected' as const,
          reason: `${lastReason} (after ${ATTEMPTS_PER_PERSONA} attempts)`,
          kind: lastKind,
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
        kind: outcome.kind,
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

  /** The exact `TickSteps.analysts` shape (orchestrator/types.ts) — empty array = quorum skip */
  async analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
    bar: Date;
  }): Promise<AnalystView[]> {
    const result = await this.runAnalysts(input.trace_id, input.signal, input.clock, input.bar);
    return result.views;
  }
}
