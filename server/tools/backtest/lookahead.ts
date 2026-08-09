/**
 * No-lookahead audit (ticket #88). See docs/specs/cost-model-backtest-spec.md
 * ("Module: Backtest Harness" — No-lookahead audit).
 *
 * No-lookahead is *primarily* enforced below the pipeline: the data services
 * return only rows timestamped `<= clock.now()` (cross-spec contract #5).
 * This auditor is the harness's assertion pass on top of that — the audit,
 * not the enforcement. Spec posture: audited like a security vulnerability,
 * so a detected violation **fails the run rather than warning**.
 *
 * It throws instead of returning a verdict deliberately: a returned flag is a
 * value a caller can ignore and still consume the run's trades, which is
 * exactly the "warning" behaviour the spec rules out. A throw is unignorable
 * and aborts before a poisoned trade is produced.
 */
import type { Clock } from '../../shared/index.js';

/** The offending read: what was read, when it is stamped, and the replay's T. */
export interface LookaheadViolation {
  /** The store/data read that served the row, e.g. 'bars' or 'latest_mark'. */
  source: string;
  /** The row's own timestamp — strictly after `clock_now` is the violation. */
  row_timestamp: Date;
  /** `clock.now()` at the moment of the read: the replay's simulated T. */
  clock_now: Date;
}

/** Thrown on a detected lookahead read. Aborts the run; never caught to warn. */
export class LookaheadViolationError extends Error {
  constructor(readonly violation: LookaheadViolation) {
    super(
      `Lookahead violation: read from '${violation.source}' returned a row timestamped ` +
        `${violation.row_timestamp.toISOString()}, which is after clock.now() = ` +
        `${violation.clock_now.toISOString()}. The run is failed, not warned.`,
    );
    this.name = 'LookaheadViolationError';
  }
}

/**
 * Asserts every audited read is point-in-time against the injected clock.
 * A row stamped exactly at `clock.now()` is legal (the current bar); only a
 * row stamped strictly after it is a violation.
 */
export class LookaheadAuditor {
  constructor(private readonly clock: Clock) {}

  /** Audits one row's timestamp. Throws `LookaheadViolationError` on a future read. */
  auditRead(source: string, rowTimestamp: Date): void {
    const now = this.clock.now();
    if (rowTimestamp.getTime() > now.getTime()) {
      throw new LookaheadViolationError({
        source,
        row_timestamp: new Date(rowTimestamp.getTime()),
        clock_now: now,
      });
    }
  }

  /**
   * Audits a batch of rows, returning them unchanged so the check can wrap a
   * data-service read inline. Rows are audited in order, so the error names
   * the first offending row rather than an arbitrary one.
   */
  auditRows<T extends { timestamp: Date }>(source: string, rows: readonly T[]): readonly T[] {
    for (const row of rows) {
      this.auditRead(source, row.timestamp);
    }
    return rows;
  }
}
