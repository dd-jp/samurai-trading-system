// @vitest-environment jsdom
/**
 * #1141: equity sampling was previously reachable only by rendering `<App/>`.
 * Pinned here directly against the hook: the dedupe on an unchanged poll, the
 * non-finite guard, the absent-balance skip, and the `MAX_EQUITY_SAMPLES` cap.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test-fixtures.ts';
import { MAX_EQUITY_SAMPLES, useEquitySamples } from './useEquitySamples.ts';
import type { WireSnapshot } from './useSnapshot.ts';

function snapshotWithBalance(
  balance: WireSnapshot['providers']['alpaca']['balance'],
  observed_at: string,
): WireSnapshot {
  const base = makeSnapshot();
  return {
    ...base,
    providers: {
      ...base.providers,
      alpaca: { ...base.providers.alpaca, balance, observed_at },
    },
  };
}

describe('useEquitySamples', () => {
  it('starts empty before any snapshot arrives', () => {
    const { result } = renderHook(() => useEquitySamples(null));
    expect(result.current).toEqual([]);
  });

  it('skips entirely when the balance is absent, and does not fold a null snapshot', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot | null }) => useEquitySamples(snapshot),
      { initialProps: { snapshot: null as WireSnapshot | null } },
    );
    rerender({ snapshot: snapshotWithBalance(null, '2026-08-07T12:00:00.000Z') });
    expect(result.current).toEqual([]);
  });

  it('refuses non-finite equity', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot | null }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance(
            { cash: 1, equity: Number.NaN, buying_power: 1 },
            '2026-08-07T12:00:00.000Z',
          ),
        },
      },
    );
    expect(result.current).toEqual([]);
    rerender({
      snapshot: snapshotWithBalance(
        { cash: 1, equity: Number.POSITIVE_INFINITY, buying_power: 1 },
        '2026-08-07T12:00:03.000Z',
      ),
    });
    expect(result.current).toEqual([]);
  });

  it('records a first valid sample', () => {
    const { result } = renderHook(() =>
      useEquitySamples(
        snapshotWithBalance(
          { cash: 1, equity: 1_000, buying_power: 1 },
          '2026-08-07T12:00:00.000Z',
        ),
      ),
    );
    expect(result.current).toEqual([{ observed_at: '2026-08-07T12:00:00.000Z', equity: 1_000 }]);
  });

  it('drops a repeated poll whose observed_at AND equity both match the previous sample', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance(
            { cash: 1, equity: 1_000, buying_power: 1 },
            '2026-08-07T12:00:00.000Z',
          ),
        },
      },
    );
    rerender({
      snapshot: snapshotWithBalance(
        { cash: 1, equity: 1_000, buying_power: 1 },
        '2026-08-07T12:00:00.000Z',
      ),
    });
    expect(result.current).toHaveLength(1);
  });

  it('keeps a sample when observed_at repeats but equity changed', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance(
            { cash: 1, equity: 1_000, buying_power: 1 },
            '2026-08-07T12:00:00.000Z',
          ),
        },
      },
    );
    rerender({
      snapshot: snapshotWithBalance(
        { cash: 1, equity: 1_001, buying_power: 1 },
        '2026-08-07T12:00:00.000Z',
      ),
    });
    expect(result.current).toEqual([
      { observed_at: '2026-08-07T12:00:00.000Z', equity: 1_000 },
      { observed_at: '2026-08-07T12:00:00.000Z', equity: 1_001 },
    ]);
  });

  it('keeps a sample when equity repeats but observed_at changed', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance(
            { cash: 1, equity: 1_000, buying_power: 1 },
            '2026-08-07T12:00:00.000Z',
          ),
        },
      },
    );
    rerender({
      snapshot: snapshotWithBalance(
        { cash: 1, equity: 1_000, buying_power: 1 },
        '2026-08-07T12:00:03.000Z',
      ),
    });
    expect(result.current).toEqual([
      { observed_at: '2026-08-07T12:00:00.000Z', equity: 1_000 },
      { observed_at: '2026-08-07T12:00:03.000Z', equity: 1_000 },
    ]);
  });

  it('treats a repeated null observed_at with unchanged equity as the same sample', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance(
            { cash: 1, equity: 1_000, buying_power: 1 },
            null as unknown as string,
          ),
        },
      },
    );
    rerender({
      snapshot: snapshotWithBalance(
        { cash: 1, equity: 1_000, buying_power: 1 },
        null as unknown as string,
      ),
    });
    expect(result.current).toEqual([{ observed_at: null, equity: 1_000 }]);
  });

  it('caps the series at MAX_EQUITY_SAMPLES, dropping from the front', () => {
    const total = MAX_EQUITY_SAMPLES + 5;
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: WireSnapshot }) => useEquitySamples(snapshot),
      {
        initialProps: {
          snapshot: snapshotWithBalance({ cash: 1, equity: 0, buying_power: 1 }, 'poll-0'),
        },
      },
    );
    for (let i = 1; i < total; i++) {
      rerender({
        snapshot: snapshotWithBalance({ cash: 1, equity: i, buying_power: 1 }, `poll-${i}`),
      });
    }
    expect(result.current).toHaveLength(MAX_EQUITY_SAMPLES);
    expect(result.current[0]?.equity).toBe(total - MAX_EQUITY_SAMPLES);
    expect(result.current[result.current.length - 1]?.equity).toBe(total - 1);
  });
});
