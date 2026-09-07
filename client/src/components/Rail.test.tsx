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
import { makeMetrics, makeSnapshot } from '../test-fixtures.ts';
import { Rail } from './Rail.tsx';

const GENERATED_AT = '2026-08-07T12:00:00.000Z';
/**
 * Distinct from `GENERATED_AT` on purpose: `test-fixtures.ts` defaults both
 * `generated_at` and `as_of` to the same constant, so a foot assertion made
 * against that default passes whichever of the two fields the foot reads.
 */
const SNAPSHOT_AS_OF = '2026-08-07T11:59:40.000Z';

function makeFeed(overrides: Partial<SnapshotFeed> = {}): SnapshotFeed {
  return {
    snapshot: makeSnapshot({ generated_at: GENERATED_AT, as_of: SNAPSHOT_AS_OF }),
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
    expect(screen.getByText('snapshot 11:59:40Z')).toBeTruthy();
    expect(screen.queryByText('snapshot 12:00:05Z')).toBeNull();
    expect(screen.queryByText('snapshot 12:00:35Z')).toBeNull();
  });

  it('dates a STALE rail by the server generated_at, not by the client poll clock', () => {
    renderRail(makeFeed({ stale: true, lastSuccessAt: '2026-08-07T12:00:35.000Z' }));

    expect(screen.getByText(/stale — last update 12:00:00Z/)).toBeTruthy();
    expect(screen.queryByText(/last update 12:00:35Z/)).toBeNull();
  });
});

/**
 * #1201: crossing the drawdown's index tolerance had no *dedicated*
 * indication beyond the track's colour turning `bad` — the head's
 * "value / cap" text and the track's accessible label are words, and both
 * name the tolerance — but neither is conditioned on the over state, so
 * neither says it has been crossed. Of the rail's two `CapMeter`s, the
 * LLM-cap one's footnote does state it (`over cap · `); `DrawdownBlock`'s footnote
 * discarded `CapMeter`'s `over` argument and never spoke the over state at
 * all.
 */
describe('Rail — drawdown meter', () => {
  it('says the drawdown is over tolerance when max drawdown reaches the index tolerance', () => {
    renderRail(
      makeFeed({ snapshot: makeSnapshot({ metrics: makeMetrics({ max_drawdown: 0.262 }) }) }),
    );

    expect(screen.getByText(/over tolerance ·/)).toBeTruthy();
  });

  it('says nothing about being over tolerance while inside it', () => {
    renderRail(
      makeFeed({ snapshot: makeSnapshot({ metrics: makeMetrics({ max_drawdown: 0.018 }) }) }),
    );

    expect(screen.queryByText(/over tolerance/)).toBeNull();
  });

  it('pins the empty state shown before any daily suite has run', () => {
    renderRail(makeFeed({ snapshot: null }));

    expect(screen.getByText('no daily suite yet — meter not drawable')).toBeTruthy();
    expect(screen.queryByText(/over tolerance/)).toBeNull();
  });

  /**
   * #1264: `metrics` present (a suite DID run) but `max_drawdown` unreadable
   * must not read as "no daily suite yet" — that sentence is reserved for
   * `metrics === null`, asserted by the pinned test above. `Number.isFinite`
   * rejects `NaN`, `Infinity` and `-Infinity` by the same mechanism (none of
   * the three is a finite double) — the routes below are asserted separately
   * anyway because each is a distinct way a real upstream computation goes
   * wrong (a 0/0, an overflow, a sign error), not because the guard treats
   * them differently. A wrong-typed value and a same-value overflow (a
   * finite `max_drawdown` whose quotient against the tolerance is itself
   * non-finite) are asserted too, matching the spec's four-route list.
   */
  it('says the drawdown figure could not be read when max_drawdown is NaN, not that no suite ran', () => {
    renderRail(
      makeFeed({ snapshot: makeSnapshot({ metrics: makeMetrics({ max_drawdown: Number.NaN }) }) }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
    expect(screen.queryByText('no daily suite yet — meter not drawable')).toBeNull();
  });

  it('says the drawdown figure could not be read when max_drawdown is +Infinity', () => {
    renderRail(
      makeFeed({
        snapshot: makeSnapshot({
          metrics: makeMetrics({ max_drawdown: Number.POSITIVE_INFINITY }),
        }),
      }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
    expect(screen.queryByText('no daily suite yet — meter not drawable')).toBeNull();
  });

  it('says the drawdown figure could not be read when max_drawdown is -Infinity', () => {
    renderRail(
      makeFeed({
        snapshot: makeSnapshot({
          metrics: makeMetrics({ max_drawdown: Number.NEGATIVE_INFINITY }),
        }),
      }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
    expect(screen.queryByText('no daily suite yet — meter not drawable')).toBeNull();
  });

  it('says the drawdown figure could not be read when max_drawdown is wrong-typed on the wire', () => {
    renderRail(
      makeFeed({
        snapshot: makeSnapshot({
          metrics: makeMetrics({ max_drawdown: '0.2' as unknown as number }),
        }),
      }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
    expect(screen.queryByText('no daily suite yet — meter not drawable')).toBeNull();
  });

  /**
   * A finite `max_drawdown` is not sufficient for `'drawn'`: `CapMeter`
   * itself divides by `DRAWDOWN_TOLERANCE` and refuses to draw a non-finite
   * quotient. `1e308 / 0.262` overflows `Infinity`, so a value large enough
   * to overflow must land in `'unreadable'` too, or `drawdownReasonOf` would
   * hand `CapMeter` an empty `emptyState` for a meter it still won't draw —
   * rendering no sentence at all.
   */
  it('says the drawdown figure could not be read when a finite max_drawdown overflows against the tolerance', () => {
    renderRail(
      makeFeed({ snapshot: makeSnapshot({ metrics: makeMetrics({ max_drawdown: 1e308 }) }) }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
  });
});
