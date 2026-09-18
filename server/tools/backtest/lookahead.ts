import type { Clock } from '../../shared/index.js';

export interface LookaheadViolation {
  source: string;
  row_timestamp: Date;
  clock_now: Date;
}

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

export class LookaheadAuditor {
  constructor(private readonly clock: Clock) {}

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

  auditRows<T extends { timestamp: Date }>(source: string, rows: readonly T[]): readonly T[] {
    for (const row of rows) {
      this.auditRead(source, row.timestamp);
    }
    return rows;
  }
}
