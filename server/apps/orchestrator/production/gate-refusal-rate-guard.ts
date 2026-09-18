import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger } from '../types.js';

export const GATE_REFUSAL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const GATE_REFUSAL_RATE_THRESHOLD = 0.95;

export const MIN_DECISIONS_FOR_GATE_REFUSAL_RATE = 20;

export const GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY = 20;

export interface GateRefusalWindowCounts {
  gate_refused: number;
  debates_logged: number;
}

export interface GateRefusalWindowSource {
  getGateRefusalWindowCounts(from: Date, to: Date): GateRefusalWindowCounts;
}

export interface GateRefusalRateAlert {
  rate: number;
  gate_refused_count: number;
  decision_count: number;
  window_ms: number;
  reported_at: Date;
}

export interface GateRefusalRateAlertChannel {
  postGateRefusalRateAlert(alert: GateRefusalRateAlert): void | Promise<void>;
}

export interface LlmGateRefusalSink {
  recordGateRefusal(occurred_at: Date): void;
}

export class GateRefusalRateMonitor {
  #firing = false;
  #checkFailureStreak = 0;

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

  recordCheckFailure(): boolean {
    this.#checkFailureStreak += 1;
    return (
      this.#checkFailureStreak === 1 ||
      this.#checkFailureStreak % GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY === 0
    );
  }

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
