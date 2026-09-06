// @vitest-environment jsdom
/**
 * The rail's health note (#1166): ALIVE's "polled" word must read the
 * client's own `lastSuccessAt`, not the server's `generated_at` on the
 * snapshot — those are two different clocks, and a stall in one must not
 * read as freshness in the other.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SnapshotFeed } from '../hooks/useSnapshot.ts';
import { makeSnapshot } from '../test-fixtures.ts';
import { Rail } from './Rail.tsx';

const GENERATED_AT = '2026-08-07T12:00:00.000Z';

function makeFeed(overrides: Partial<SnapshotFeed> = {}): SnapshotFeed {
  return {
    snapshot: makeSnapshot({ generated_at: GENERATED_AT }),
    stale: false,
    lastSuccessAt: '2026-08-07T12:00:05.000Z',
    error: null,
    ...overrides,
  };
}

function renderRail(feed: SnapshotFeed) {
  return render(<Rail feed={feed} tab="glance" onTab={() => {}} />);
}

describe('Rail — poll clock', () => {
  it('reads the client lastSuccessAt, not the snapshot generated_at, when ALIVE', () => {
    renderRail(makeFeed());

    expect(screen.getByText('polled 12:00:05Z')).toBeTruthy();
    expect(screen.queryByText('polled 12:00:00Z')).toBeNull();
  });

  it('advances the visible poll clock across a re-poll that carries no new data', () => {
    const { rerender } = renderRail(makeFeed({ lastSuccessAt: '2026-08-07T12:00:05.000Z' }));
    expect(screen.getByText('polled 12:00:05Z')).toBeTruthy();

    // A re-poll that hands back the same `generated_at` (a stall in the
    // underlying data) but succeeded at a later wall-clock time: the poll
    // clock must move even though the snapshot clock does not, or a live
    // client on a stalled feed reads as though it had itself gone quiet.
    rerender(
      <Rail
        feed={makeFeed({ lastSuccessAt: '2026-08-07T12:00:35.000Z' })}
        tab="glance"
        onTab={() => {}}
      />,
    );

    expect(screen.getByText('polled 12:00:35Z')).toBeTruthy();
    expect(screen.queryByText('polled 12:00:05Z')).toBeNull();
    // The snapshot-side clock is unmoved by the client's own poll clock —
    // proof the two are reading distinct sources, not the same value twice.
    expect(screen.getByText('snapshot 12:00:00Z')).toBeTruthy();
  });
});
