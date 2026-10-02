import { describe, expect, it } from 'vitest';
import { type JournalledCheck, journalledSpendCap } from './replay-spend-cap.js';
import { ARM2_SLEEVE_ID, DEBATE_SLEEVE_ID } from './signal/index.js';

const debate = (instrument: string, reason: string): JournalledCheck => ({
  sleeve_id: DEBATE_SLEEVE_ID,
  instrument,
  reason,
});

describe('journalledSpendCap', () => {
  it('answers each name from its own journalled refusal', () => {
    const cap = journalledSpendCap([
      debate('AAA', 'judge: bullish'),
      { ...debate('ZZZ', 'llm_spend_cap:budget'), sleeve_id: ARM2_SLEEVE_ID },
      debate('BBB', 'llm_spend_cap:budget'),
      debate('CCC', 'llm_spend_cap:read_fault'),
      debate('DDD', 'llm_spend_cap:corrupt_ledger'),
    ]);
    expect(cap.check('AAA')).toEqual({
      admitted: true,
      spent_usd: 0,
      budget_usd: Number.POSITIVE_INFINITY,
    });
    expect(cap.check('BBB')).toMatchObject({ admitted: false, kind: 'budget' });
    expect(cap.check('CCC')).toMatchObject({ admitted: false, kind: 'read_fault' });
    expect(cap.check('DDD')).toMatchObject({ admitted: false, kind: 'corrupt_ledger' });
    expect(cap.check('ZZZ').admitted).toBe(true);
    expect(cap.check('EEE').admitted).toBe(true);
    expect(cap.check().admitted).toBe(true);
  });

  it('keeps a read_fault on A when a sat-out B was journalled before it', () => {
    const cap = journalledSpendCap([
      debate('B', 'late_wake_entry_cutoff'),
      debate('A', 'llm_spend_cap:read_fault'),
    ]);
    expect(cap.check('A')).toMatchObject({ admitted: false, kind: 'read_fault' });
    expect(cap.check('B').admitted).toBe(true);
  });

  it('gives a refused name followed by admitted ones the same answers across two books', () => {
    const cap = journalledSpendCap([
      debate('BBB', 'llm_spend_cap:budget'),
      debate('CCC', 'judge: bullish'),
      debate('BBB', 'llm_spend_cap:budget'),
      debate('CCC', 'judge: bullish'),
    ]);
    expect(cap.check('BBB')).toMatchObject({ admitted: false, kind: 'budget' });
    expect(cap.check('CCC').admitted).toBe(true);
    expect(cap.check('BBB')).toMatchObject({ admitted: false, kind: 'budget' });
    expect(cap.check('CCC').admitted).toBe(true);
  });

  it('admits a reason with the prefix but no known refusal kind', () => {
    expect(journalledSpendCap([debate('AAA', 'llm_spend_cap:other')]).check('AAA').admitted).toBe(
      true,
    );
  });
});
