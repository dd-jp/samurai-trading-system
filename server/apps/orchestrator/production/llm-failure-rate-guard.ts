/**
 * The `debate_log.termination_cause = 'llm_failure'` rate alert (#1396).
 *
 * `SqliteDebateLogStore` (#1380, migration 0051) has recorded WHY a
 * latency-truncated debate stopped early since #1380 landed, but nothing
 * read the column: an escaped `LlmClient` failure and ordinary
 * latency-budget starvation both write `termination = 'latency_truncated'`
 * and neither shape alerted, so a sustained 429 storm read identically to
 * routine fan-out pressure in the log.
 *
 * ## Why a rate, not a raw count
 *
 * #1080 measured 41 of 44 live debates timing out in one 2026-09-04
 * session — BEFORE #1380 split the cause, so that 93% figure is
 * truncation overall, not `llm_failure` specifically.
 *
 * ## First real measurement (#1427) — still PROVISIONAL
 *
 * `debate_log.termination_cause` has now recorded two real episodes
 * (`data/samurai-paper.sqlite`, queried 2026-09-15): a genuine provider
 * outage, 2026-09-14T13:31Z-14:07Z, 32/32 = 1.0 (every `llm_call_failed`
 * in the window carried `failure_cause: "timeout"`, "LLM call exceeded
 * 28000ms"); and an orchestrator-restart transient, 2026-09-10T20:00Z-
 * 20:03Z, 2/19 = 0.105 (17 of those 19 truncations were in-flight calls
 * `cancelled` by the restart, not ordinary budget expiry). `0.25` clears
 * the first by 0.75 and sits 0.145 above the second, so neither
 * contradicts it — but every cause-tagged truncation observed so far comes
 * from one of these two pathological events. No window of ordinary
 * operation (budget-pressure truncations with no outage or restart
 * underneath) has been measured, so the threshold's SENSITIVITY side —
 * whether 0.25 is low enough to page on routine noise — remains untested;
 * `LLM_FAILURE_RATE_THRESHOLD` stays PROVISIONAL rather than backed by a
 * measurement that could have falsified it. Closing this needs a
 * continuous soak spanning multiple full 24h windows whose truncations
 * come from budget pressure rather than shutdown or outage, to establish
 * a baseline non-failure truncation rate to calibrate against.
 *
 * ## The window source lives beside the writer
 *
 * The rate needs an AGGREGATE count over a window, computed by the
 * orchestrator process that already owns `SqliteDebateLogStore` — not by
 * `SqliteQueryStore` (service-api), which is a separate process with no
 * Telegram/alert-channel wiring of its own (it only DISPLAYS the
 * `alert_delivery_failures` counts the orchestrator writes). The read lives
 * on `SqliteDebateLogStore` itself (see its own doc for why it is not on
 * the shared `DebateLogStore` port) rather than as a new cross-app
 * construction of `SqliteQueryStore` from the orchestrator.
 *
 * ## Edge-triggered, unlike `MiCoverageMonitor`
 *
 * `LlmFailureRateMonitor` posts only on the check where the rate CROSSES
 * the threshold from below (or from "not enough samples"), and re-arms only
 * once the rate drops back below it — a pure latch, so a sustained outage
 * does not flood the escalation chat. This differs from `MiCoverageMonitor`
 * (production/mi-coverage.ts), which re-alerts every
 * `ALERT_REPEAT_EVERY_NO_DATA` (8) consecutive misses even while still
 * degraded: coverage gaps are worth a periodic nudge across a long outage,
 * a rate-threshold crossing is not.
 *
 * ## The floor
 *
 * A window with fewer than `MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE` truncations
 * never fires — one failed debate out of one truncation is a 100% rate on no
 * evidence. This counts truncations, not every debate in the window (review
 * round 1 F2 — see `getTerminationCauseWindowCounts`'s doc), so a quiet
 * stream that is mostly clean convergences and rarely truncates can sit
 * below the floor even on a busy tick cadence. Mirrors
 * `MIN_TRADES_PER_ARM_FOR_DIVERGENCE`'s reasoning
 * (feedback-loop/arm-comparison-cycle.ts) for the same "not enough samples
 * to mean anything" floor.
 *
 * ## Re-arming below the floor (review round 2 finding 1)
 *
 * The floor above and the rate's window are the SAME trailing window, so a
 * storm's failing rows age out of it alongside its clean truncations rather
 * than being replaced by fresh clean ones. A quiet stream can then pass
 * through a stretch where the storm has mostly aged out (too few truncations
 * left to trust a rate) before enough NEW truncations arrive to read one
 * under threshold again — under a floor that only gates firing, that stretch
 * never clears the latch, and the guard is then one-shot for the process
 * lifetime: a second genuine storm posts nothing until restart. `observe`
 * below re-arms independently of the floor whenever the window's
 * `llm_failure` COUNT reaches zero — zero is trustworthy however few
 * truncations the window holds, unlike a RATE computed from too few of them.
 */
import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger } from '../types.js';

/**
 * Same 24h cadence `COVERAGE_WINDOW_MS` (production/mi-coverage.ts) and
 * `getDailyMetrics` already use for a "how is today going" read — still
 * convention-based, not measurement-based. #1427's real episodes (this
 * file's doc comment) were 3-36 minutes long, too short to say whether a
 * shorter window would separate outage from blip any better; unchanged.
 */
export const LLM_FAILURE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PROVISIONAL — see this file's doc comment. One in four truncations
 * outright LLM failures, rather than budget expiry, is the bar chosen to
 * flag a stream where failures are no longer the minority cause. #1427's
 * first two real episodes (2026-09-15 measurement, this file's doc
 * comment) sit well clear of 0.25 on both sides (1.0 and 0.105) without
 * testing where the true cutover lies, so this is not yet a value a
 * measurement has pinned down — only one a measurement has failed to
 * contradict.
 */
export const LLM_FAILURE_RATE_THRESHOLD = 0.25;

/** Mirrors `MIN_TRADES_PER_ARM_FOR_DIVERGENCE` — below this many truncations, a rate is noise, not a measurement. */
export const MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE = 5;

/** How often `llm_failure_rate_check_failed` repeats while the window read keeps failing (review round 2 finding 8). */
export const CHECK_FAILURE_LOG_EVERY = 20;

export interface LlmFailureRateWindowCounts {
  llm_failure: number;
  total: number;
}

/** The one method this guard calls on `SqliteDebateLogStore` — declared here so the guard depends on a capability, not a concrete class. */
export interface LlmFailureRateWindowSource {
  getTerminationCauseWindowCounts(from: Date, to: Date): LlmFailureRateWindowCounts;
}

export interface LlmFailureRateAlert {
  rate: number;
  llm_failure_count: number;
  total_count: number;
  window_ms: number;
  reported_at: Date;
}

/** Where the llm-failure-rate alert goes. Declared beside its caller, the same convention `MiCoverageAlertChannel` (mi-coverage.ts) sets. */
export interface LlmFailureRateAlertChannel {
  postLlmFailureRateAlert(alert: LlmFailureRateAlert): void | Promise<void>;
}

/**
 * Edge-triggered latch over the computed rate (see file doc). In-memory and
 * restart-clean, the same posture `MiCoverageMonitor` takes: a process that
 * just restarted has no evidence about the previous process's window.
 */
export class LlmFailureRateMonitor {
  #firing = false;
  #checkFailureStreak = 0;

  /**
   * Records one rate observation and reports whether an alert is due.
   * `hasEnoughSamples` gates firing and re-arming VIA THE RATE: a quiet
   * window (too few truncations) is not "recovered" by rate alone, it is "no
   * evidence either way" for a rate specifically, so it neither fires nor
   * clears the latch through the rate branch below.
   *
   * `llmFailureCount` reaching zero clears the latch independently of
   * `hasEnoughSamples` (review round 2 finding 1): a window holding zero
   * `llm_failure` rows is zero evidence of an ongoing failure however few
   * truncations it holds, which is not the same claim as "the rate is
   * trustworthy" — so it re-arms a latch the floor alone would otherwise
   * hold forever once the storm's failing rows age out of the trailing
   * window ahead of enough clean truncations to read a rate under threshold.
   */
  observe(rate: number, hasEnoughSamples: boolean, llmFailureCount: number): { alert: boolean } {
    if (llmFailureCount === 0) {
      this.#firing = false;
      return { alert: false };
    }
    if (!hasEnoughSamples) {
      return { alert: false };
    }
    if (rate < LLM_FAILURE_RATE_THRESHOLD) {
      this.#firing = false;
      return { alert: false };
    }
    if (this.#firing) {
      return { alert: false };
    }
    this.#firing = true;
    return { alert: true };
  }

  /**
   * Throttles `llm_failure_rate_check_failed` (review round 2 finding 8, the
   * repo's per-kind-throttle precedent at #1376): true on the first failure
   * of a streak and every `CHECK_FAILURE_LOG_EVERY`-th after, so a sustained
   * `SQLITE_BUSY` does not log at debate cadence. Single-kind — there is only
   * the one window-read failure this guard can log — so a plain streak
   * counter suffices; #1376's per-kind map exists for `SpendCapRefusalKind`,
   * which this call site does not have.
   */
  recordCheckFailure(): boolean {
    this.#checkFailureStreak += 1;
    return (
      this.#checkFailureStreak === 1 || this.#checkFailureStreak % CHECK_FAILURE_LOG_EVERY === 0
    );
  }

  /** Resets the check-failure streak so a later, unrelated outage logs its own first occurrence rather than inheriting a stale count. */
  recordCheckSuccess(): void {
    this.#checkFailureStreak = 0;
  }
}

export interface CheckLlmFailureRateDeps {
  windowSource: LlmFailureRateWindowSource;
  monitor: LlmFailureRateMonitor;
  alertChannel: LlmFailureRateAlertChannel | undefined;
  logger: Logger | undefined;
}

/**
 * Recomputes the window rate and posts the alert when the monitor says one
 * is due. **Never throws.** The call site (`debate-adapter.ts`) invokes this
 * as `void checkLlmFailureRate(...)` — fire-and-forget — so a rejection here
 * would become an unhandled rejection, which `installFaultHandlers`
 * (orchestrator/index.ts) treats as fatal and exits the process. Unlike
 * `checkMiCoverage`'s single try (production/mi-coverage.ts), whose one
 * synchronous read is over in-memory state, `getTerminationCauseWindowCounts`
 * is a synchronous `better-sqlite3` call that can throw (SQLITE_BUSY, IO,
 * a closed handle, the write-guard) — so it needs the same try/catch
 * discipline as the alert POST, not just the awaited half.
 */
export async function checkLlmFailureRate(deps: CheckLlmFailureRateDeps, now: Date): Promise<void> {
  let llm_failure: number;
  let total: number;
  let rate: number;
  let alert: boolean;
  try {
    const from = new Date(now.getTime() - LLM_FAILURE_RATE_WINDOW_MS);
    ({ llm_failure, total } = deps.windowSource.getTerminationCauseWindowCounts(from, now));
    deps.monitor.recordCheckSuccess();
    rate = total === 0 ? 0 : llm_failure / total;
    ({ alert } = deps.monitor.observe(
      rate,
      total >= MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE,
      llm_failure,
    ));
  } catch (error) {
    if (deps.monitor.recordCheckFailure()) {
      deps.logger?.log({
        trace_id: 'llm-failure-rate',
        stage: 'debate',
        event: 'llm_failure_rate_check_failed',
        level: 'error',
        message: 'LLM-failure-rate window read failed — the rate for this tick is unknown',
        payload: { error: describeThrownSafely(error) },
      });
    }
    return;
  }

  if (!alert) {
    return;
  }

  try {
    await deps.alertChannel?.postLlmFailureRateAlert({
      rate,
      llm_failure_count: llm_failure,
      total_count: total,
      window_ms: LLM_FAILURE_RATE_WINDOW_MS,
      reported_at: now,
    });
  } catch (error) {
    deps.logger?.log({
      trace_id: 'llm-failure-rate',
      stage: 'debate',
      event: 'llm_failure_rate_alert_send_failed',
      level: 'error',
      message: 'LLM-failure-rate alert could not be delivered — the rate is still elevated',
      payload: {
        rate,
        llm_failure_count: llm_failure,
        total_count: total,
        error: describeThrownSafely(error),
      },
    });
  }
}
