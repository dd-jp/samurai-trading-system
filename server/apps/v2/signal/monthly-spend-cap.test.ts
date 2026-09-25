import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  LLM_MONTHLY_BUDGET_USD,
  SqliteMonthlySpendCap,
  utcMonthStart,
} from './monthly-spend-cap.js';

function spend(db: StoreHandle, costUsd: number, timestamp: string): void {
  db.prepare(
    `INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp)
     VALUES ('t', 'debate', 'anthropic/claude-sonnet-5', 1, 1, ?, 1, ?)`,
  ).run(costUsd, timestamp);
}

describe('SqliteMonthlySpendCap', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');

  it('defaults to a $30 budget', () => {
    expect(LLM_MONTHLY_BUDGET_USD).toBe(30);
  });

  it('starts the window at the first of the UTC month', () => {
    expect(utcMonthStart(now).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(utcMonthStart(new Date('2026-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('counts only this month and refuses at the budget', () => {
    const db = openSharedStore(':memory:');
    const cap = new SqliteMonthlySpendCap(db, new SimulatedClock(now), 30);
    spend(db, 100, '2026-08-31T23:59:59.000Z');
    expect(cap.check()).toEqual({ admitted: true, spent_usd: 0, budget_usd: 30 });
    spend(db, 29.99, '2026-09-01T00:00:00.000Z');
    expect(cap.check().admitted).toBe(true);
    spend(db, 0.01, '2026-09-25T11:00:00.000Z');
    const verdict = cap.check();
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.kind).toBe('budget');
      expect(verdict.spent_usd).toBeCloseTo(30, 6);
      expect(verdict.reason).toContain('since 2026-09-01');
    }
  });

  it('fails closed on a read fault and on a corrupt ledger', () => {
    const db = openSharedStore(':memory:');
    const cap = new SqliteMonthlySpendCap(db, new SimulatedClock(now));
    db.prepare(
      "INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp) VALUES ('t','debate','m',1,1,?,1,'2026-09-02T00:00:00.000Z')",
    ).run(Number.POSITIVE_INFINITY);
    const corrupt = cap.check();
    expect(corrupt.admitted).toBe(false);
    if (!corrupt.admitted) {
      expect(corrupt.kind).toBe('corrupt_ledger');
      expect(corrupt.reason).toContain('not finite');
    }

    db.exec('DROP TABLE llm_spend');
    const fault = cap.check();
    expect(fault.admitted).toBe(false);
    if (!fault.admitted) {
      expect(fault.kind).toBe('read_fault');
      expect(fault.reason).toContain('unreadable');
    }
  });

  it('rejects a non-positive budget', () => {
    const db = openSharedStore(':memory:');
    expect(() => new SqliteMonthlySpendCap(db, new SimulatedClock(now), 0)).toThrow(/positive/);
  });
});
