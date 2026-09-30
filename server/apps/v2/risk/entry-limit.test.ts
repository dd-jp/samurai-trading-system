import { describe, expect, it } from 'vitest';
import type { SleeveDecision } from '../../../../contracts/index.js';
import {
  ENTRY_LIMIT_OFFSET,
  entryLimitFor,
  marketableLimit,
  offsetRefusal,
} from './entry-limit.js';

const decision = { price: 200 } as SleeveDecision;

describe('entry limit (#1815)', () => {
  it('declares the ruled reference and cap', () => {
    expect(ENTRY_LIMIT_OFFSET).toEqual({ reference: 'decision_close', capBps: 50 });
  });

  it('offsets a buy 50 bps above the decision close and a short 50 bps below it', () => {
    expect(marketableLimit('buy', 200)).toBeCloseTo(201, 9);
    expect(marketableLimit('sell', 200)).toBeCloseTo(199, 9);
  });

  it("keeps a sleeve's own limit and offsets only a decision-close entry", () => {
    expect(entryLimitFor('buy', decision)).toBeCloseTo(201, 9);
    expect(entryLimitFor('sell', decision)).toBeCloseTo(199, 9);
    expect(entryLimitFor('buy', { ...decision, entry_limit: 198.5 })).toBe(198.5);
  });

  it('refuses a limit at or past the stop, then one at or past the target', () => {
    expect(offsetRefusal('buy', 201, 196, 206)).toBeUndefined();
    expect(offsetRefusal('buy', 196, 196, 206)).toBe('offset_past_stop');
    expect(offsetRefusal('buy', 206, 196, 206)).toBe('offset_past_target');
    expect(offsetRefusal('buy', 206, 206, 206)).toBe('offset_past_stop');
    expect(offsetRefusal('sell', 199, 204, 194)).toBeUndefined();
    expect(offsetRefusal('sell', 204, 204, 194)).toBe('offset_past_stop');
    expect(offsetRefusal('sell', 194, 204, 194)).toBe('offset_past_target');
  });
});
