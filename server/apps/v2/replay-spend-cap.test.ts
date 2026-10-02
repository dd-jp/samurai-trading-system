import { describe, expect, it } from 'vitest';
import { type JournalledCheck, journalledSpendCap } from './replay-spend-cap.js';
import { ARM2_SLEEVE_ID, DEBATE_SLEEVE_ID } from './signal/index.js';

const debate = (instrument: string, reason: string, inputs_hash = 'h'): JournalledCheck => ({
  sleeve_id: DEBATE_SLEEVE_ID,
  instrument,
  inputs_hash,
  reason,
});

describe('journalledSpendCap', () => {
  it('answers each check in decision order from the journalled refusals', () => {
    const cap = journalledSpendCap([
      debate('AAA', 'judge: bullish'),
      { ...debate('ZZZ', 'llm_spend_cap:budget'), sleeve_id: ARM2_SLEEVE_ID },
      debate('BBB', 'llm_spend_cap:budget'),
      debate('CCC', 'llm_spend_cap:read_fault'),
      debate('DDD', 'llm_spend_cap:corrupt_ledger'),
    ]);
    expect(cap.check()).toEqual({
      admitted: true,
      spent_usd: 0,
      budget_usd: Number.POSITIVE_INFINITY,
    });
    expect(cap.check()).toMatchObject({ admitted: false, kind: 'budget' });
    expect(cap.check()).toMatchObject({ admitted: false, kind: 'read_fault' });
    expect(cap.check()).toMatchObject({ admitted: false, kind: 'corrupt_ledger' });
    expect(cap.check().admitted).toBe(true);
  });

  it('skips names that stopped before the check and the same name in a second book', () => {
    const cap = journalledSpendCap([
      debate('AAA', 'no_bars', ''),
      debate('BBB', 'llm_spend_cap:budget'),
      debate('BBB', 'judge: bullish'),
      debate('CCC', 'judge: bearish'),
    ]);
    expect(cap.check()).toMatchObject({ admitted: false, kind: 'budget' });
    expect(cap.check().admitted).toBe(true);
  });

  it('admits a reason with the prefix but no known refusal kind', () => {
    expect(journalledSpendCap([debate('AAA', 'llm_spend_cap:other')]).check().admitted).toBe(true);
  });
});
