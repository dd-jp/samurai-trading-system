/**
 * The in-flight-gate refusal-rate alert (#1533), a signal of its own — NOT a
 * term folded into `LlmFailureRateGuard`'s truncation rate next door.
 *
 * ## Why separate (review round 1 F1)
 *
 * `gateRefusedDebateResult` (debate-adapter.ts) writes no `debate_log` row, so
 * `LlmFailureRateGuard` sees a refusal in neither its numerator nor its
 * denominator: a soak where every debate is refused reads to that guard as an
 * empty, perfectly healthy window. The first attempt at closing that blind
 * spot blended refusals into BOTH sides of the truncation rate, and that is
 * unusable at the shipped defaults. `DEFAULT_MAX_IN_FLIGHT_LLM_CALLS` (1) and
 * `DEFAULT_EXPECTED_NOUS_CALL_MS` (13,000) admit two of the six instruments a
 * pass runs concurrently and refuse the other four AT ZERO COST, BY DESIGN
 * (`production/defaults.ts`) — roughly 384 refusals a day at a 15-minute
 * cadence. Truncations on a healthy run are near zero, so a blended rate is
 * `refusals / refusals` ~= 1.0 on every healthy pass: it crosses
 * `LLM_FAILURE_RATE_THRESHOLD` immediately, and because
 * `LlmFailureRateMonitor` is an edge-triggered latch that clears only on a
 * rate BELOW threshold, it then never clears. A genuine provider outage a week
 * later would post nothing at all — strictly worse than the blind spot.
 *
 * So the truncation rate keeps the narrow, deliberately-chosen denominator
 * `getTerminationCauseWindowCounts`'s doc argues for, and refusals get their
 * own rate, own floor, own threshold, own latch and own alert here.
 *
 * ## What counts as anomalous
 *
 * Not refusal VOLUME — the designed steady state is high volume. The gate
 * admits a fixed small number per wave (two, at the shipped cap and expected
 * call time), so the by-design refusal ratio is `(N - 2) / N` in
 * `maxConcurrentInstruments` N: 0.667 at the shipped N = 6, 0.90 at N = 20.
 * What is anomalous is the ratio climbing toward 1 — the gate no longer
 * shedding surplus load but admitting almost nobody, which is the shape a
 * stuck permit, a wedged queue or a collapse in throughput takes.
 *
 * ## The threshold is a PLACEHOLDER
 *
 * `GATE_REFUSAL_RATE_THRESHOLD` below is not a measured constant. No soak has
 * yet written `llm_gate_refusals` at all, so there is no measured distribution
 * of the refusal ratio to calibrate against — the 0.667 baseline above is
 * derived from the gate's admission arithmetic, not observed. #1533 defers
 * calibration explicitly ("Refs #1427 (threshold recalibration)"), and #1427
 * owns turning this into a predicate derived from the configured
 * `maxConcurrentInstruments` / `maxInFlightLlmCalls` rather than a flat
 * number. Until then this is picked for headroom over every plausible shipped
 * configuration, and the headroom is finite — see the constant's own doc.
 */
import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger } from '../types.js';

/** The same 24h window `LLM_FAILURE_RATE_WINDOW_MS` uses, for the same "how is today going" read. */
export const GATE_REFUSAL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PLACEHOLDER, not a measurement — see this file's doc.
 *
 * 0.95 is chosen to clear the by-design `(N - 2) / N` baseline at every width
 * this system plausibly runs: 0.667 at the shipped `maxConcurrentInstruments`
 * of 6 (28 pp of headroom), 0.90 if that cap were ever widened to 20 (5 pp).
 * Universe SIZE does not move the baseline — the 20-name sweep `defaults.ts`
 * and the debate-engine spec both reason about runs at width 6, so it is four
 * waves at 0.667, not one at 0.90. The headroom runs out at a width of 40,
 * where the designed baseline IS 0.95 and this would alert on healthy
 * operation; a cap that wide needs #1427's derived predicate first, not a
 * larger flat number.
 */
export const GATE_REFUSAL_RATE_THRESHOLD = 0.95;

/**
 * Below this many gate decisions (refusals plus debates that ran) in the
 * window, a ratio is noise — one refusal out of one decision is a 100% rate on
 * no evidence. Mirrors `MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE`'s reasoning with
 * a larger number because this population is larger by construction: 20
 * decisions is between three and four passes at the shipped
 * `maxConcurrentInstruments` of 6, so a single unlucky wave cannot carry a
 * window on its own.
 */
export const MIN_DECISIONS_FOR_GATE_REFUSAL_RATE = 20;

/** How often `gate_refusal_rate_check_failed` repeats while the window read keeps failing, matching `CHECK_FAILURE_LOG_EVERY`. */
export const GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY = 20;

export interface GateRefusalWindowCounts {
  /** Rows in `llm_gate_refusals` over the window (migration 0065). */
  gate_refused: number;
  /**
   * `debate_log` rows over the window — every debate that RAN, converged or
   * truncated alike, not the truncated subset the sibling guard reads. A
   * refusal costs a whole debate, so the population it is measured against is
   * whole debates.
   */
  debates_logged: number;
}

/** The one method this guard calls on `SqliteDebateLogStore` — a capability, not a concrete class, the same shape `LlmFailureRateWindowSource` takes. */
export interface GateRefusalWindowSource {
  getGateRefusalWindowCounts(from: Date, to: Date): GateRefusalWindowCounts;
}

export interface GateRefusalRateAlert {
  rate: number;
  gate_refused_count: number;
  /** `gate_refused_count` plus the debates that ran — the denominator of `rate`, named for what it is so no reader mistakes it for every pass attempt. */
  decision_count: number;
  window_ms: number;
  reported_at: Date;
}

/** Where the gate-refusal-rate alert goes. Declared beside its caller, the convention `LlmFailureRateAlertChannel` sets. */
export interface GateRefusalRateAlertChannel {
  postGateRefusalRateAlert(alert: GateRefusalRateAlert): void | Promise<void>;
}

/**
 * Where a gate-refused debate is recorded so this guard's window can count it.
 * `SqliteDebateLogStore` implements it directly — the same "bolted onto the
 * concrete class, not the shared `DebateLogStore` port" precedent #785 set and
 * `LlmFailureRateWindowSource` already follows.
 */
export interface LlmGateRefusalSink {
  recordGateRefusal(occurred_at: Date): void;
}

/**
 * Edge-triggered latch over the refusal ratio, the same posture
 * `LlmFailureRateMonitor` takes: post on the crossing, re-arm on the return,
 * in-memory and restart-clean.
 */
export class GateRefusalRateMonitor {
  #firing = false;
  #checkFailureStreak = 0;

  /**
   * `refusedCount` reaching zero clears the latch regardless of
   * `hasEnoughSamples`, mirroring `LlmFailureRateMonitor.observe`'s round-2
   * finding-1 branch and for the same reason: the floor and the rate share one
   * trailing window, so a storm's refusals can age out through a stretch too
   * quiet to read a trustworthy ratio, and a latch that only cleared through
   * the rate branch would then be one-shot for the process lifetime. A window
   * holding zero refusals is trustworthy evidence at any sample size.
   */
  observe(rate: number, hasEnoughSamples: boolean, refusedCount: number): { alert: boolean } {
    if (refusedCount === 0) {
      this.#firing = false;
      return { alert: false };
    }
    if (!hasEnoughSamples) {
      return { alert: false };
    }
    if (rate < GATE_REFUSAL_RATE_THRESHOLD) {
      this.#firing = false;
      return { alert: false };
    }
    if (this.#firing) {
      return { alert: false };
    }
    this.#firing = true;
    return { alert: true };
  }

  /** Throttles `gate_refusal_rate_check_failed`, matching `LlmFailureRateMonitor.recordCheckFailure`. */
  recordCheckFailure(): boolean {
    this.#checkFailureStreak += 1;
    return (
      this.#checkFailureStreak === 1 ||
      this.#checkFailureStreak % GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY === 0
    );
  }

  /** Resets the check-failure streak so a later, unrelated outage logs its own first occurrence. */
  recordCheckSuccess(): void {
    this.#checkFailureStreak = 0;
  }
}

export interface CheckGateRefusalRateDeps {
  windowSource: GateRefusalWindowSource;
  monitor: GateRefusalRateMonitor;
  alertChannel: GateRefusalRateAlertChannel | undefined;
  logger: Logger | undefined;
}

/**
 * Recomputes the window ratio and posts the alert when the monitor says one is
 * due. **Never throws**, for the reason `checkLlmFailureRate` never throws:
 * the call site invokes it as `void checkGateRefusalRate(...)`, so a rejection
 * would be an unhandled rejection, which `installFaultHandlers`
 * (orchestrator/index.ts) treats as fatal. The window read is a synchronous
 * `better-sqlite3` call that can throw (SQLITE_BUSY, IO, a closed handle), so
 * it needs the try/catch as much as the alert POST does.
 */
export async function checkGateRefusalRate(
  deps: CheckGateRefusalRateDeps,
  now: Date,
): Promise<void> {
  let refused: number;
  let decisions: number;
  let rate: number;
  let alert: boolean;
  try {
    const from = new Date(now.getTime() - GATE_REFUSAL_RATE_WINDOW_MS);
    const counts = deps.windowSource.getGateRefusalWindowCounts(from, now);
    deps.monitor.recordCheckSuccess();
    refused = counts.gate_refused;
    decisions = refused + counts.debates_logged;
    rate = decisions === 0 ? 0 : refused / decisions;
    ({ alert } = deps.monitor.observe(
      rate,
      decisions >= MIN_DECISIONS_FOR_GATE_REFUSAL_RATE,
      refused,
    ));
  } catch (error) {
    if (deps.monitor.recordCheckFailure()) {
      deps.logger?.log({
        trace_id: 'gate-refusal-rate',
        stage: 'debate',
        event: 'gate_refusal_rate_check_failed',
        level: 'error',
        message: 'Gate-refusal-rate window read failed — the ratio for this tick is unknown',
        payload: { error: describeThrownSafely(error) },
      });
    }
    return;
  }

  if (!alert) {
    return;
  }

  try {
    await deps.alertChannel?.postGateRefusalRateAlert({
      rate,
      gate_refused_count: refused,
      decision_count: decisions,
      window_ms: GATE_REFUSAL_RATE_WINDOW_MS,
      reported_at: now,
    });
  } catch (error) {
    deps.logger?.log({
      trace_id: 'gate-refusal-rate',
      stage: 'debate',
      event: 'gate_refusal_rate_alert_send_failed',
      level: 'error',
      message: 'Gate-refusal-rate alert could not be delivered — the ratio is still elevated',
      payload: {
        rate,
        gate_refused_count: refused,
        decision_count: decisions,
        error: describeThrownSafely(error),
      },
    });
  }
}
