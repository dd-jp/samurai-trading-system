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
    status: 'alive',
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
    renderRail(
      makeFeed({ stale: true, status: 'stale', lastSuccessAt: '2026-08-07T12:00:35.000Z' }),
    );

    expect(screen.getByText(/stale — last update 12:00:00Z/)).toBeTruthy();
    expect(screen.queryByText(/last update 12:00:35Z/)).toBeNull();
  });
});

/**
 * #1316: a served client bundle disagreeing with the server's wire contract
 * must be visually distinct from both ALIVE and STALE, and none of the
 * six health-derived tiles may keep computing off `snapshot` while it holds
 * — they read as unknown, not calm (the decision comment's own words). Each
 * test below is mutation evidence in the sense the task asks for: before
 * `status: 'contract-mismatch'` existed as a case `Rail.tsx` branched on,
 * every one of these would have rendered the SAME output a healthy poll
 * does (a zero-failure `AlertDeliveryBlock` renders nothing either way,
 * which is the exact defect #1316 is named for).
 */
describe('Rail — contract mismatch (#1316)', () => {
  function mismatchedFeed(overrides: Partial<SnapshotFeed> = {}): SnapshotFeed {
    return makeFeed({
      status: 'contract-mismatch',
      stale: false,
      snapshot: null,
      error:
        "served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects abc123)",
      ...overrides,
    });
  }

  it('renders the MISMATCH word, not ALIVE, STALE or WAITING', () => {
    renderRail(mismatchedFeed());

    expect(screen.getByText('MISMATCH')).toBeTruthy();
    expect(screen.queryByText('ALIVE')).toBeNull();
    expect(screen.queryByText('STALE')).toBeNull();
    expect(screen.queryByText('WAITING')).toBeNull();
  });

  it('states the mismatch error under the health word', () => {
    renderRail(
      mismatchedFeed({
        error:
          "served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects abc123)",
      }),
    );

    expect(screen.getByText(/disagrees with the server's wire contract/)).toBeTruthy();
  });

  it('replaces every health-derived tile with an explicit "unknown" reading rather than a computed one, even against a snapshot that would otherwise render healthy values', () => {
    // The snapshot here is NOT null and NOT unhealthy — a fully populated,
    // ordinary-looking payload. The point: `status` alone must be what gates
    // these tiles, not whether `snapshot` happens to be present or "look
    // fine". If any block below read off `snapshot` instead of `status`, this
    // test would see the healthy value (a mode pill, a live-tick line, a
    // providers block) instead of the mismatch reading.
    renderRail(mismatchedFeed({ snapshot: makeSnapshot() }));

    const mismatchTiles = screen.getAllByText('unknown — contract mismatch');
    // Mode, live tick, alert channel, providers, LLM cap, drawdown.
    expect(mismatchTiles.length).toBe(6);
  });

  it('shows a visible alert-channel tile during a mismatch even though the count is 0 — never the silent, no-tile reading a healthy channel gets', () => {
    // This is #1316's actual bug, reproduced directly: `AlertDeliveryBlock`
    // alone renders NOTHING for `alert_delivery_failures_24h: 0`, which is
    // indistinguishable from "the field could not be read". During a
    // mismatch this tile must be visible and explicit instead.
    renderRail(
      mismatchedFeed({
        snapshot: makeSnapshot({ alert_delivery_failures_24h: 0 }),
      }),
    );

    const alertTile = screen
      .getByText('Alert channel')
      .closest('[data-field="alert-delivery-failures"]');
    expect(alertTile).toBeTruthy();
    expect(alertTile?.textContent).toContain('unknown — contract mismatch');
  });

  it('never renders a healthy 0-failure alert tile as absent alongside a mismatch, the way a healthy poll legitimately would', () => {
    // Sanity check on the CONTROL case this issue is about: a genuinely
    // healthy snapshot with 0 failures renders NO alert-channel tile at all
    // — that absence is fine there. Pinned here so a change that made the
    // mismatch path start reusing `AlertDeliveryBlock` (and so re-absorb the
    // bug) would be caught by the test above, not silently pass because this
    // file never exercised the healthy 0-failure case.
    renderRail(makeFeed({ snapshot: makeSnapshot({ alert_delivery_failures_24h: 0 }) }));

    expect(screen.queryByText('Alert channel')).toBeNull();
  });

  it('marks the rail visually distinct from the stale state (a different border/data attribute), not merely stale-with-extra-text', () => {
    const { container } = renderRail(mismatchedFeed());
    const aside = container.querySelector('aside');

    expect(aside?.className).toContain('rail-mismatch');
    expect(aside?.className).not.toContain('rail-stale');
    expect(aside?.getAttribute('data-contract-mismatch')).toBe('true');
    expect(aside?.getAttribute('data-stale')).toBe('false');
  });

  it('outranks staleness: a poll that is BOTH mismatched and watchdog-stale still reads MISMATCH, never STALE', () => {
    // `useSnapshot.ts`'s `deriveStatus` never actually produces this
    // combination (mismatch always implies `stale: false`), but `Rail.tsx`
    // must not derive its own, second opinion from the raw booleans either —
    // it must read `status` and trust it. This pins that Rail has no local
    // fallback path that would disagree.
    renderRail(mismatchedFeed({ stale: true }));

    expect(screen.getByText('MISMATCH')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
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
   * `metrics === null`, asserted by the pinned test above.
   *
   * `drawdownValueOf` has two independent gates, and the routes below split
   * across both: a `typeof value !== 'number'` check (catches the wrong-typed
   * and `null` cases below — neither is ever seen by `Number.isFinite`, since
   * the `typeof` gate returns first) and `Number.isFinite(value /
   * DRAWDOWN_TOLERANCE)` (catches `NaN`, `Infinity`, `-Infinity` — rejected by
   * the same mechanism, none of the three is a finite double — and the
   * overflow case, a finite `max_drawdown` whose quotient against the
   * tolerance is itself non-finite). They're asserted as six separate tests
   * because each is a distinct way a real value goes bad on the wire, not
   * because either guard treats them differently from its siblings on the
   * same gate.
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
   * `null` is not a hypothetical wrong type: `JSON.stringify` casts
   * `NaN`/`Infinity`/`-Infinity` to literal `null`, so an upstream
   * computation that goes non-finite and is then serialized onto the wire
   * would arrive at this component as `null`, not as the original
   * non-finite number. `max_drawdown` itself takes no such route today —
   * both `SqliteQueryStore.getDailyMetrics` and the fixture store hardcode
   * it (`ZERO_METRICS.max_drawdown = 0`, `DAILY_METRICS.max_drawdown =
   * 0.118`), so this test is defensive against a future real computation,
   * not a route this field is observed to take now. The cast mechanism
   * itself is not hypothetical, though — it WAS live on a sibling field of
   * this same `MetricsSuite`: `profitFactor` returns
   * `Number.POSITIVE_INFINITY` for any window with wins and no losses (a
   * routine day), and `server.ts`'s `JSON.stringify` used to turn that into
   * `profit_factor: null` on the wire. #1270 closed that specific route —
   * `buildSnapshot` now converts `profit_factor` through
   * `contracts/metrics.ts`'s `toProfitFactorWire` before it ever reaches
   * `JSON.stringify`, so the wire carries `{ kind: 'no_losses' }`, not
   * `null` — but the mechanism it demonstrated is still real and is still
   * why this gate exists for `max_drawdown`. `typeof null === 'object'`, so
   * `max_drawdown: null` takes the same `typeof` gate as the string case
   * above, before `CapMeter`'s own `value === undefined` check ever sees
   * it — without that gate, `null / DRAWDOWN_TOLERANCE === 0`, a finite
   * quotient, and `CapMeter` would draw a meter at 0% regardless of what
   * reason this component computed.
   */
  it('says the drawdown figure could not be read when max_drawdown is null on the wire', () => {
    renderRail(
      makeFeed({
        snapshot: makeSnapshot({
          metrics: makeMetrics({ max_drawdown: null as unknown as number }),
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
    expect(screen.queryByText('no daily suite yet — meter not drawable')).toBeNull();
  });
});
