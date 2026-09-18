import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger } from '../types.js';

export const LLM_FAILURE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LLM_FAILURE_RATE_THRESHOLD = 0.25;

const MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE = 5;

export const CHECK_FAILURE_LOG_EVERY = 20;

export interface LlmFailureRateWindowCounts {
  llm_failure: number;
  total: number;
}

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

export interface LlmFailureRateAlertChannel {
  postLlmFailureRateAlert(alert: LlmFailureRateAlert): void | Promise<void>;
}

export class LlmFailureRateMonitor {
  #firing = false;
  #checkFailureStreak = 0;

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

  recordCheckFailure(): boolean {
    this.#checkFailureStreak += 1;
    return (
      this.#checkFailureStreak === 1 || this.#checkFailureStreak % CHECK_FAILURE_LOG_EVERY === 0
    );
  }

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
