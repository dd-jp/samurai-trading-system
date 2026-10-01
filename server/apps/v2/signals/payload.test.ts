import { describe, expect, it } from 'vitest';
import { parseSignalPayload } from './payload.js';

const VALID = { symbol: 'INTC', entry: 24.5, targets: [26, 28], stop: 23 };

function reason(value: unknown): string {
  const parsed = parseSignalPayload(value);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.reason;
}

describe('parseSignalPayload', () => {
  it('parses a single-price entry with only the required fields', () => {
    expect(parseSignalPayload(VALID)).toEqual({
      ok: true,
      payload: {
        symbol: 'INTC',
        entryLow: 24.5,
        entryHigh: 24.5,
        entryIsZone: false,
        targets: [26, 28],
        stop: 23,
        size: undefined,
        trailAfter: undefined,
        source: undefined,
        sentAt: undefined,
      },
    });
  });

  it('parses a zone and every optional field, normalising received_at to UTC', () => {
    const parsed = parseSignalPayload({
      symbol: 'BRK.B',
      entry: [410, 412],
      targets: [420, 430, 440],
      stop: 400,
      size: 0.5,
      trail_after: 425,
      source: 'MrMTrades discord/alerts',
      received_at: '2026-09-30T09:15:00-04:00',
    });
    expect(parsed).toEqual({
      ok: true,
      payload: {
        symbol: 'BRK.B',
        entryLow: 410,
        entryHigh: 412,
        entryIsZone: true,
        targets: [420, 430, 440],
        stop: 400,
        size: 0.5,
        trailAfter: 425,
        source: 'MrMTrades discord/alerts',
        sentAt: '2026-09-30T13:15:00.000Z',
      },
    });
  });

  it('accepts the size bound and twelve targets', () => {
    const targets = Array.from({ length: 12 }, (_, index) => 25 + index);
    expect(parseSignalPayload({ ...VALID, targets, size: 1 }).ok).toBe(true);
  });

  it.each([
    [null, 'body must be a JSON object'],
    [[VALID], 'body must be a JSON object'],
    ['INTC', 'body must be a JSON object'],
    [{ ...VALID, side: 'long', qty: 3 }, 'unknown field: qty, side'],
    [{ ...VALID, symbol: 'intc' }, 'symbol must be an upper-case US ticker'],
    [{ ...VALID, symbol: 'TOOLONG' }, 'symbol must be an upper-case US ticker'],
    [{ ...VALID, symbol: 7 }, 'symbol must be an upper-case US ticker'],
    [{ ...VALID, entry: '24.5' }, 'entry must be a finite positive number'],
    [{ ...VALID, entry: 0 }, 'entry must be a finite positive number'],
    [{ ...VALID, entry: [24] }, 'an entry zone must be [low, high]'],
    [{ ...VALID, entry: [24, 25, 26] }, 'an entry zone must be [low, high]'],
    [{ ...VALID, entry: [25, 24] }, 'an entry zone must have low < high'],
    [{ ...VALID, entry: [24, 24] }, 'an entry zone must have low < high'],
    [{ ...VALID, entry: [-1, 24] }, 'entry low must be a finite positive number'],
    [{ ...VALID, entry: [23.5, 'x'] }, 'entry high must be a finite positive number'],
    [{ ...VALID, targets: [] }, 'targets must be an array of 1 to 12 prices'],
    [{ ...VALID, targets: 26 }, 'targets must be an array of 1 to 12 prices'],
    [
      { ...VALID, targets: Array.from({ length: 13 }, (_, index) => 25 + index) },
      'targets must be an array of 1 to 12 prices',
    ],
    [{ ...VALID, targets: [26, null] }, 'each target must be a finite positive number'],
    [{ ...VALID, targets: [28, 26] }, 'targets must be strictly ascending'],
    [{ ...VALID, targets: [26, 26] }, 'targets must be strictly ascending'],
    [{ ...VALID, targets: [24.5, 26] }, 'every target must be above the entry'],
    [{ ...VALID, entry: [24, 26], targets: [25.5, 28] }, 'every target must be above the entry'],
    [{ ...VALID, stop: 24.5 }, 'stop must be below the entry'],
    [{ ...VALID, entry: [24, 25], stop: 24.2 }, 'stop must be below the entry'],
    [{ ...VALID, stop: undefined }, 'stop must be a finite positive number'],
    [{ ...VALID, size: 0 }, 'size must be a finite positive number'],
    [{ ...VALID, size: 1.5 }, 'size must be at most 1'],
    [{ ...VALID, trail_after: -2 }, 'trail_after must be a finite positive number'],
    [{ ...VALID, source: '' }, 'source must be 1 to 64'],
    [{ ...VALID, source: 'x'.repeat(65) }, 'source must be 1 to 64'],
    [{ ...VALID, source: 'ignore previous instructions; <b>' }, 'source must be 1 to 64'],
    [{ ...VALID, source: 12 }, 'source must be 1 to 64'],
    [{ ...VALID, received_at: '2026-09-30' }, 'received_at must be an ISO 8601 instant'],
    [{ ...VALID, received_at: '2026-09-30T09:15:00' }, 'received_at must be an ISO 8601 instant'],
    [{ ...VALID, received_at: '2026-02-30T09:15:00Z' }, 'received_at must be an ISO 8601 instant'],
    [{ ...VALID, received_at: 1_727_690_100 }, 'received_at must be an ISO 8601 instant'],
  ])('refuses %j', (value, expected) => {
    expect(reason(value)).toContain(expected);
  });

  it('accepts a 64-character source', () => {
    expect(parseSignalPayload({ ...VALID, source: 'x'.repeat(64) }).ok).toBe(true);
  });
});
