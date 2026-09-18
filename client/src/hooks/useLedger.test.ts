// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { doneThrough, makeView } from '../lib/test-support.ts';
import { makeSnapshot } from '../test-fixtures.ts';
import { useLedger } from './useLedger.ts';
import type { WireSnapshot } from './useSnapshot.ts';

function snapshotWith(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
  return { ...makeSnapshot(), ...overrides };
}

describe('useLedger', () => {
  it('starts empty when the first snapshot has settled nothing', () => {
    const { result } = renderHook(() => useLedger(snapshotWith()));
    expect(result.current).toEqual([]);
  });

  it('seeds from the first snapshot’s already-settled lanes', () => {
    const settled = doneThrough('ETH-USD', 'trace-eth', 'execution', { outcome: 'go' });
    const { result } = renderHook(() => useLedger(snapshotWith({ pipeline: makeView([settled]) })));
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-eth']);
  });

  it('appends a newly-settled lane on a later poll, never stamping the same trace twice', () => {
    const settled = doneThrough('ETH-USD', 'trace-eth', 'execution', { outcome: 'go' });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useLedger(snapshot),
      { initialProps: { snapshot: snapshotWith({ pipeline: makeView([settled]) }) } },
    );
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-eth']);

    rerender({
      snapshot: snapshotWith({ pipeline: makeView([settled]), as_of: '2026-08-07T12:00:03.000Z' }),
    });
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-eth']);

    const secondSettled = doneThrough('BTC-USD', 'trace-btc', 'verdict', {
      startMs: 60_000,
      outcome: 'no_go',
    });
    rerender({
      snapshot: snapshotWith({
        pipeline: makeView([settled, secondSettled]),
        as_of: '2026-08-07T12:00:06.000Z',
      }),
    });
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-btc', 'trace-eth']);
  });
});
