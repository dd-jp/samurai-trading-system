import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import { escalatesAt, type TradingArm } from '../../../shared/index.js';

export interface TraderDiagnosticAlert {
  instrument: string;
  diagnostic: TraderDiagnostic;
  arm?: TradingArm;
  consecutive_ticks: number;
  reported_at: Date;
}

export interface TraderDiagnosticAlertChannel {
  postTraderDiagnosticAlert(alert: TraderDiagnosticAlert): Promise<void>;
}

export interface ObservedTraderDiagnostic {
  diagnostic: TraderDiagnostic;
  consecutive_ticks: number;
  alert: boolean;
}

const ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS = 1;

export const ALERT_REPEAT_EVERY_DIAGNOSTICS = 8;

const DIAGNOSTIC_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS,
  every: ALERT_REPEAT_EVERY_DIAGNOSTICS,
};

function shouldAlertAtDiagnosticCount(consecutive: number): boolean {
  return escalatesAt(consecutive, DIAGNOSTIC_CADENCE);
}

export class TraderDiagnosticThrottle {
  readonly #consecutive = new Map<string, number>();

  observe(instrument: string, present: readonly TraderDiagnostic[]): ObservedTraderDiagnostic[] {
    const seen = new Set<string>();
    const observed: ObservedTraderDiagnostic[] = [];

    const distinct = new Map<string, TraderDiagnostic>();
    for (const diagnostic of present) {
      if (!distinct.has(diagnostic.kind)) distinct.set(diagnostic.kind, diagnostic);
    }

    for (const diagnostic of distinct.values()) {
      const key = `${instrument}\0${diagnostic.kind}`;
      seen.add(key);
      const count = (this.#consecutive.get(key) ?? 0) + 1;
      this.#consecutive.set(key, count);
      observed.push({
        diagnostic,
        consecutive_ticks: count,
        alert: shouldAlertAtDiagnosticCount(count),
      });
    }

    const prefix = `${instrument}\0`;
    for (const key of this.#consecutive.keys()) {
      if (key.startsWith(prefix) && !seen.has(key)) this.#consecutive.delete(key);
    }

    return observed;
  }
}
