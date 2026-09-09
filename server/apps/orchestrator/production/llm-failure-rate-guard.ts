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
 * truncation overall, not `llm_failure` specifically. Nothing has yet
 * measured an `llm_failure` rate on its own: `LLM_FAILURE_RATE_THRESHOLD`
 * below is therefore PROVISIONAL, picked so the alert fires once outright
 * failures stop being a minority of an already truncation-heavy stream
 * rather than at a level backed by a soak measurement. It is due for
 * recalibration from the first soak that writes this column — not attempted
 * here, since there is no `llm_failure` measurement yet to recalibrate
 * against.
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
 * A window with fewer than `MIN_DEBATES_FOR_LLM_FAILURE_RATE` truncations
 * never fires — one failed debate out of one truncation is a 100% rate on no
 * evidence. This counts truncations, not every debate in the window (review
 * round 1 F2 — see `getTerminationCauseWindowCounts`'s doc), so a quiet
 * stream that is mostly clean convergences and rarely truncates can sit
 * below the floor even on a busy tick cadence. Mirrors
 * `MIN_TRADES_PER_ARM_FOR_DIVERGENCE`'s reasoning
 * (feedback-loop/arm-comparison-cycle.ts) for the same "not enough samples
 * to mean anything" floor.
 */
import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger } from '../types.js';

/** Same 24h cadence `COVERAGE_WINDOW_MS` (production/mi-coverage.ts) and `getDailyMetrics` already use for a "how is today going" read. */
export const LLM_FAILURE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PROVISIONAL — see this file's doc comment. One in four truncations
 * outright LLM failures, rather than budget expiry, is the bar chosen to
 * flag a stream where failures are no longer the minority cause.
 */
export const LLM_FAILURE_RATE_THRESHOLD = 0.25;

/** Mirrors `MIN_TRADES_PER_ARM_FOR_DIVERGENCE` — below this many truncations, a rate is noise, not a measurement. */
export const MIN_DEBATES_FOR_LLM_FAILURE_RATE = 5;

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

  /**
   * Records one rate observation and reports whether an alert is due.
   * `hasEnoughSamples` gates BOTH firing and re-arming below the floor: a
   * quiet window (too few debates) is not "recovered", it is "no evidence
   * either way", so it neither fires nor counts as the good reading that
   * clears a prior alert — the monitor stays latched until a window with
   * enough samples reads back under threshold.
   */
  observe(rate: number, hasEnoughSamples: boolean): { alert: boolean } {
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
    rate = total === 0 ? 0 : llm_failure / total;
    ({ alert } = deps.monitor.observe(rate, total >= MIN_DEBATES_FOR_LLM_FAILURE_RATE));
  } catch (error) {
    deps.logger?.log({
      trace_id: 'llm-failure-rate',
      stage: 'debate',
      event: 'llm_failure_rate_check_failed',
      level: 'error',
      message: 'LLM-failure-rate window read failed — the rate for this tick is unknown',
      payload: { error: describeThrownSafely(error) },
    });
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
