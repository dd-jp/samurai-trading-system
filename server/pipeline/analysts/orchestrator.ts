/**
 * Analyst Orchestrator (ticket #71) — see docs/specs/analysts-spec.md
 * "Module: Analyst Orchestrator". Fans a Signal out across every applicable
 * persona (Technical + Fundamental + Sentiment for the equities Samurai runs
 * — crypto left scope entirely on 2026-08-16, ADR-0015's amendment — per
 * `Analyst.applies_to`) and enforces the role-dependent quorum: a mandatory
 * persona failing blocks the whole tick (analysts-spec.md story 21, "no stale
 * fallback"), an optional persona failing just shrinks the set (story 22).
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
 * The "short timeout" of analysts-spec.md story 19, as a number.
 *
 * What a persona waits on is market data over HTTP, not an LLM — the personas
 * are mechanical (technical reads indicators, fundamental returns a constant,
 * sentiment reads an in-memory store) — and specifically it waits on the QUEUE
 * in front of that HTTP. Bar fetches take `acquireBackground()` on the Alpaca
 * token bucket shared with the order path (`shared/http/venue-pacing.ts`),
 * which holds 20 tokens above the order path's reserve and refills at 2.0/s,
 * while one sweep of the 20-instrument universe reaches the venue for up to
 * four distinct windows per instrument — a WARM-STORE count; a first-ever tick
 * against an empty store asks eight and drains for 70s, which this deadline
 * does not cover (analysts-spec.md, \"Module: Failure Handling\"). A fetch that

 * cannot get a token has not
 * started, so a deadline under the drain times the back of every sweep out by
 * construction — the 2026-09-10 19:56 burst measured 91 of 133 fetches past
 * 10,000ms with a median of 21,338ms, which is #1080's instance 2: `technical
 * did not answer within 10000ms` on 57% of main-arm runs, with no fault logged
 * anywhere because there was none.
 *
 * 30,000ms is that drain, derived rather than chosen: `(20 instruments *
 * 4 windows - 20 tokens of headroom) / 2.0 per second`. The derivation is
 * pinned from the pacing side by `production/rate-limit-wiring.test.ts`, which
 * is where the bucket's constants live. `ATTEMPTS_PER_PERSONA` is 2, so the
 * per-persona wall clock is up to `ANALYST_STAGE_WALL_CLOCK_MS`, which is what
 * `paper-profile.test.ts`'s pass-duration arithmetic consumes. Those
 * two attempts may be waiting on the SAME fetch: the retry carries no
 * `AbortSignal`, so attempt 1's request is still in flight and attempt 2 joins
 * it through `MarketDataServiceImpl.inFlightBarFetches` instead of re-asking
 * the venue. Against a queue — which is what this deadline is sized for — that
 * is the right trade; liveness against a stuck fetch comes from
 * `fetchWithTimeout`, not from the retry.
 *
 * The other half of #1080's instance 2 is upstream of this number: concurrent
 * callers asking for the SAME window no longer each spend a token
 * (`MarketDataServiceImpl.inFlightBarFetches`), which removed 74% of the
 * measured burst. This deadline covers what remains after that.
 *
 * The point of having a timeout at all is that `Promise.all` below has no
 * deadline of its own: one persona whose fetch never settles hangs the whole
 * analyst stage forever, and an unattended run has nobody to notice.
 *
 * **There is no enclosing analyst-stage budget for this number to be divided
 * out of, and #1104 resolves that deliberately rather than inventing one.**
 * The debate arm's per-attempt timeout is a division: a logical LLM call runs
 * inside `LATENCY_BUDGET_MS`, so `maxAttempts x (timeoutMs + maxDelayMs) <=
 * LATENCY_BUDGET_MS.stocks` fixes it from above. Nothing downstream measures
 * the analyst stage's wall clock, and specifically not the two gates
 * `paper-profile.ts`'s `maxConcurrentInstruments` comment names: Verdict's
 * gate 1 measures `now - orderIntent.decided_at` (verdict/index.ts), and
 * `decided_at` is `clock.now()` read inside that instrument's OWN Trader step
 * (decide.ts, `const asOf = clock.now()`), so an instrument's position in the
 * `ceil(universe / width)` walk does not enter it; gate 2 measures
 * `Mark.observed_at` on a mark `getMark` re-reads at gate time
 * (verdict/index.ts, `marketData.getMark(orderIntent.instrument, now)`) behind
 * a 5,000ms TTL (`MarketDataServiceImpl`'s `markTtlMs`, passed explicitly in
 * production.ts), so it too carries no walk position. A pass therefore
 * overruns the 120,000ms tick cadence by design (#1080) with no gate to catch
 * it. So this deadline is sized against the data source alone, and
 * `ANALYST_STAGE_WALL_CLOCK_MS` below is an OUTPUT of that sizing, not a
 * ceiling imposed on it. The human tripwire on `maxConcurrentInstruments` is
 * what is left, which is why that comment still says to revisit rather than
 * assume.
 */
/**
 * This literal is `deriveAnalystDrainMs`'s DRAIN term alone
 * (`server/shared/http/venue-pacing.ts`), not the full `deriveAnalystTimeoutMs`
 * a real deployment runs — that also adds a fetch-bound floor (#1542), so the
 * true per-attempt deadline at even the CHECKED-IN Alpaca defaults is already
 * ~60,750ms, not this 30,000ms. This constant stays a static fallback ON
 * PURPOSE (#1542 review, Finding 3): it is what a caller gets who constructs
 * `AnalystOrchestrator` directly without an explicit `timeout_ms` (tests,
 * offline paths), and what `ANALYST_STAGE_WALL_CLOCK_MS` below and
 * `paper-profile.ts`'s pass-duration tripwire comments are sized against.
 * Making it track the resolved pacing live would cascade into re-deriving a
 * chain of unrelated static tripwires (`paper-profile.test.ts`'s 172s/688s
 * pass-duration figures, `pollIntervalMs` bounds) for a minor finding — see
 * `docs/specs/analysts-spec.md`'s matching amendment for the full accounting.
 * An operator relying on this figure as a true ceiling must re-run
 * `deriveAnalystTimeoutMs` against the RESOLVED pacing by hand.
 */
export const DEFAULT_ANALYST_TIMEOUT_MS = 30_000;

/** analysts-spec.md story 19: exactly one retry, so a blip is absorbed without a retry storm. */
const ATTEMPTS_PER_PERSONA = 2;

/**
 * The analyst stage's worst-case wall clock (#1104) — the figure
 * `paper-profile.test.ts`'s pass-duration arithmetic and `paper-profile.ts`'s
 * tripwire comment each used to restate by hand as
 * "`DEFAULT_ANALYST_TIMEOUT_MS` twice".
 *
 * Exact rather than an upper bound, because `runAnalysts` fans the personas out
 * under one `Promise.all`: the stage settles when the slowest persona does, and
 * the slowest possible persona is one that exhausts every attempt. Pinned
 * behaviourally by `analyst-stage-wall-clock.test.ts` so a change to the fan-out
 * shape or the attempt count cannot leave this constant describing code that no
 * longer exists.
 *
 * Inherits `DEFAULT_ANALYST_TIMEOUT_MS`'s staleness (#1542 review, Finding 3 —
 * see that constant's doc comment): this is `ATTEMPTS_PER_PERSONA` times the
 * static DRAIN-only literal, not the real per-attempt deadline a production
 * boot wires (which also floors at a fetch-bound term), so the real worst-case
 * wall clock at even the checked-in defaults already exceeds this figure.
 */
export const ANALYST_STAGE_WALL_CLOCK_MS = ATTEMPTS_PER_PERSONA * DEFAULT_ANALYST_TIMEOUT_MS;

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
  /**
   * Where the cause behind a stage failure goes (#1114). Threaded the same
   * way `telemetry` above is: optional here, with a safe no-op default
   * (`NOOP_LOGGER`) rather than a missing field, so a caller that omits it
   * gets silence, not a crash, and `production.ts` wires the real one.
   */
  logger?: Logger;
}

/** The safe default for `AnalystOrchestratorDeps.sessionCalendars` — see its doc comment. */
function defaultSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return {
    crypto: new AlwaysOpenCalendar(),
    stocks: new AlwaysOpenCalendar(),
  };
}

/** The safe default for `AnalystOrchestratorDeps.logger` — see its doc comment. */
const NOOP_LOGGER: Logger = {
  log(): void {
    // Intentionally does nothing — same posture as `NOOP_ANALYST_TELEMETRY`:
    // a missing logger must never be able to fail a tick.
  },
};

/**
 * Renders a caught value's name, message, stack and cause into a bounded,
 * credential-safe payload (#1114).
 *
 * `describeThrown` alone collapses an `Error` to its `.message` — exactly the
 * information loss the ticket exists to close (a soak's `stage=analysts
 * level=error` line named a timeout with no way to tell an HTTP timeout from
 * a 429 from a malformed body). This keeps `name`/`stack`/`cause` too, masked
 * and capped the same way `analysts-adapter.ts` already treats every other
 * upstream-controlled failure string — a stack frame can carry a URL with
 * query params, and `cause` is arbitrary.
 */
function renderErrorDetail(error: unknown): Record<string, unknown> {
  try {
    return renderErrorFields(error);
  } catch {
    // Guards the RENDER, which `safeLog` cannot: a hostile value's throwing
    // `toString`/`Symbol.toPrimitive` (or a lazy `message` getter) throws
    // while the payload is still being built, before `safeLog`'s own
    // try/catch is ever entered — `logCaughtFailure`'s doc comment describes
    // the same hole. On the late-settlement path the escape would reject a
    // derived promise nobody holds, which Node 22 turns into process exit.
    return { message: '[unrenderable error]' };
  }
}

/**
 * Per field, so one hostile getter costs only its own field: a thrown `stack`
 * must not take the `name`/`message`/`cause` that rendered fine down with it,
 * which is the whole diagnostic value of the line.
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
 *
 * `onLateSettlement` (#1114) is how that discarded arrival is still OBSERVED.
 * It fires at most once, only on the timeout branch, with whatever `work`
 * eventually does — logged by the caller, never fed back into this
 * function's return value or anything downstream of it.
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
          // yet: `Promise.race` resolves via whichever side settles first,
          // and a `work` that had already settled would have won the race in
          // an earlier microtask checkpoint, before this macrotask-scheduled
          // callback could run. So it is safe — and correct — to attach
          // observers to `work` here, and only here: attaching eagerly at
          // call time would fire on every attempt, not only the abandoned
          // one this branch already knows was abandoned.
          //
          // This does not change what `Promise.race` does with `work`'s
          // eventual rejection: `Promise.race` already attaches its own
          // handler to every promise it's given, so a late rejection here is
          // handled-and-ignored the same way latency-budget.ts's identical
          // situation documents — `onLateSettlement` only lets the caller
          // learn what happened, it is not what prevents an unhandled
          // rejection.
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
   *
   * `bar` (#811) is the claimed decision bar's opening boundary — the caller's
   * single derivation for this pass (`DecisionGate.claim`) — threaded onto
   * every `AnalystInput` below unchanged. This class does not derive a bar of
   * its own from `clock`; see `AnalystInput.bar`'s doc comment for why a
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
        // One bounded retry, uniform across roles (analysts-spec.md story 19).
        // Every failure mode funnels through here identically — timeout, thrown
        // error, or malformed output surfacing as a throw — differing only in
        // the reason string (story 20).
        let lastReason = '';
        // The LAST attempt's kind, not a summary of both: a persona whose first
        // attempt threw and whose retry timed out is a timeout at the point the
        // stage gave up, which is the one the caller is deciding about.
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
              (outcome) => {
                // #1114: this fires strictly after the tick has already moved
                // on from this attempt (it lost the race to the deadline
                // above). Logged only — see `withTimeout`'s doc comment for
                // why the invariant "a late arrival is logged, never applied"
                // holds structurally, not by convention.
                safeLog(this.logger, {
                  trace_id,
                  stage: 'analysts',
                  level: 'debug',
                  message:
                    `analysts: ${persona.analyst_type} attempt ${attempt} settled after its ` +
                    `${this.timeoutMs}ms deadline had already been reported as a timeout — the ` +
                    `cause below, discarded rather than applied to this tick`,
                  payload: {
                    analyst_type: persona.analyst_type,
                    attempt,
                    outcome: outcome.status,
                    ...(outcome.status === 'rejected' ? renderErrorDetail(outcome.error) : {}),
                  },
                });
              },
            );
            return { persona, status: 'fulfilled' as const, view };
          } catch (error) {
            try {
              lastReason = describeThrown(error);
            } catch {
              // `describeThrown` (safe-log.ts) now coerces a non-string
              // `message` through its own JSON.stringify/String ladder
              // rather than returning it verbatim, but that ladder can still
              // throw for a value hostile enough to defeat BOTH steps — its
              // own doc comment says so — and a plain `message` getter that
              // throws outright never reaches the ladder at all. Nor does a
              // `Proxy` with a throwing `getPrototypeOf` trap: `describeThrown`'s
              // own `error instanceof Error` check runs before either surface
              // and throws there instead. Any of these throwing here would
              // escape this catch — which exists to HANDLE the persona's
              // failure — and reject the `Promise.all` below, turning a
              // handled analyst failure into a failed tick before any of this
              // loop's own logging runs. This is the same try/catch/placeholder
              // shape `logCaughtFailure` (safe-log.ts) uses for that residual
              // case.
              lastReason = '[unrenderable error]';
            }
            // `AnalystTimeoutError` is named explicitly rather than left to
            // the classifier: it is this class's own deadline, not a provider's
            // (#1394).
            lastKind =
              error instanceof AnalystTimeoutError ? 'timeout' : classifyFailureCause(error);
            // #1114's cheap half: a genuine (non-timeout) rejection already
            // carries a full `Error` right here, and the line above collapses
            // it to `lastReason`'s bare message — the same loss the ticket
            // names, just without `withTimeout`'s abandoned-promise problem.
            // Logged in addition to, never instead of, the existing
            // `lastReason`/`lastKind` bookkeeping and the error/warn line
            // `analysts-adapter.ts` builds from it.
            if (lastKind !== 'timeout') {
              safeLog(this.logger, {
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
          }
        }
        // The reason says the retry happened, so a log line cannot be read as
        // "failed once" when the persona actually failed twice.
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

  /** The exact `TickSteps.analysts` shape (orchestrator/types.ts) — empty array = quorum skip. */
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
