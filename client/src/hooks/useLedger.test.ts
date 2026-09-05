// @vitest-environment jsdom
/**
 * #1141: the ledger-accumulation rule was previously reachable only by
 * rendering `<App/>`. `lib/ledger.ts`'s pure transition is already covered
 * directly (`lib/ledger.test.ts`) — this file covers the hook that folds
 * each polled snapshot into it, driven through a sequence of snapshots with
 * no DOM assertions.
 */
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
  it('starts empty before any snapshot arrives', () => {
    const { result } = renderHook(() => useLedger(null));
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
      ({ snapshot }: { snapshot: WireSnapshot | null }) => useLedger(snapshot),
      { initialProps: { snapshot: snapshotWith({ pipeline: makeView([settled]) }) } },
    );
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-eth']);

    // Re-poll of the SAME settled lane must not re-stamp it.
    rerender({
      snapshot: snapshotWith({ pipeline: makeView([settled]), as_of: '2026-08-07T12:00:03.000Z' }),
    });
    expect(result.current.map((e) => e.trace_id)).toEqual(['trace-eth']);

    // A second, distinct trace settling appends alongside it.
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

  it('does not fold a null snapshot — nothing to accumulate yet', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot | null }) => useLedger(snapshot),
      { initialProps: { snapshot: null as WireSnapshot | null } },
    );
    expect(result.current).toEqual([]);
    rerender({ snapshot: null });
    expect(result.current).toEqual([]);
  });
});
