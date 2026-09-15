// @vitest-environment jsdom
/**
 * The rail's health note (#1166): ALIVE's "polled" word must read the
 * client's own `lastSuccessAt`, not the server's `generated_at` on the
 * snapshot — those are two different clocks, and a stall in one must not
 * read as freshness in the other.
 */
import type { TradingArmWire } from '@contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveFeed } from '../hooks/useSnapshot.ts';
import { makeMetrics, makeSnapshot, makeSpend } from '../test-fixtures.ts';
import { Rail } from './Rail.tsx';

const GENERATED_AT = '2026-08-07T12:00:00.000Z';
/**
 * Distinct from `GENERATED_AT` on purpose: `test-fixtures.ts` defaults both
 * `generated_at` and `as_of` to the same constant, so a foot assertion made
 * against that default passes whichever of the two fields the foot reads.
 */
const SNAPSHOT_AS_OF = '2026-08-07T11:59:40.000Z';

/**
 * A `LiveFeed`, not a `SnapshotFeed`: since #1520 the rail is only ever
 * rendered once a snapshot has landed — the cold start is `App.tsx`'s
 * page-level state — so there is no `snapshot: null` case to construct here.
 */
function makeFeed(overrides: Partial<LiveFeed> = {}): LiveFeed {
  return {
    snapshot: makeSnapshot({ generated_at: GENERATED_AT, as_of: SNAPSHOT_AS_OF }),
    lastSuccessAt: '2026-08-07T12:00:05.000Z',
    error: null,
    status: 'alive',
    ...overrides,
  };
}

function renderRail(feed: LiveFeed) {
  return render(<Rail feed={feed} tab="glance" onTab={() => {}} arm="live" onArm={() => {}} />);
}

function renderRailArm(arm: TradingArmWire, onArm: (next: TradingArmWire) => void) {
  return render(<Rail feed={makeFeed()} tab="glance" onTab={() => {}} arm={arm} onArm={onArm} />);
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
        arm="live"
        onArm={() => {}}
      />,
    );

    expect(screen.getByText('polled 12:00:35Z')).toBeTruthy();
    expect(screen.queryByText('polled 12:00:05Z')).toBeNull();
    expect(screen.getByText('snapshot 11:59:40Z')).toBeTruthy();
    expect(screen.queryByText('snapshot 12:00:05Z')).toBeNull();
    expect(screen.queryByText('snapshot 12:00:35Z')).toBeNull();
  });

  it('dates a STALE rail by the server generated_at, not by the client poll clock', () => {
    renderRail(makeFeed({ status: 'stale', lastSuccessAt: '2026-08-07T12:00:35.000Z' }));

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
  function mismatchedFeed(overrides: Partial<LiveFeed> = {}): LiveFeed {
    return makeFeed({
      status: 'contract-mismatch',
      error:
        "served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects abc123)",
      ...overrides,
    });
  }

  it('renders the MISMATCH word, not ALIVE, STALE or WAITING, on top of the last-known snapshot', () => {
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

  it('outranks staleness: the rail reads the ranked status and never re-derives its own opinion', () => {
    // `deriveStatus` ranks a mismatch above staleness, and since #1520 that
    // ranking is the ONLY thing the rail reads — the `stale` boolean it used
    // to carry alongside `status` is gone, so there is no second input left
    // that could disagree with the word on screen. This pins the outcome that
    // ranking exists to produce.
    renderRail(mismatchedFeed());

    expect(screen.getByText('MISMATCH')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
    expect(document.querySelector('aside')?.getAttribute('data-stale')).toBe('false');
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

  /**
   * #1264: `metrics` present (a suite DID run) but `max_drawdown` unreadable
   * must not read as "no daily suite yet". #1520 removed that sentence
   * altogether along with the only state that could reach it — a null
   * SNAPSHOT, which the page-level cold start now owns — so every case below
   * is a suite that ran and reported a figure this client cannot use.
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

/**
 * #1593: the arm selector's accessible name carries the selection state
 * itself (AC), not a separate `aria-selected`/`aria-pressed` an operator has
 * to cross-reference — so these tests read names, the same posture the rest
 * of this file's `getByRole(..., { name })` assertions already take.
 */
describe('Rail — arm selector', () => {
  it('names Live as selected and Control as not, when arm is live', () => {
    renderRailArm('live', () => {});

    const liveButton = screen.getByRole('button', { name: 'Live arm, selected' });
    expect(liveButton).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control arm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Control arm, selected' })).toBeNull();

    // Colour alone never carries selection (dashboard-spec.md:310/:560) — the
    // selected arm also carries a visible word, not just `.arm-btn-on`.
    expect(within(liveButton).getByText('· selected')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'Control arm' })).queryByText('· selected'),
    ).toBeNull();
  });

  it('names Control as selected and Live as not, when arm is control', () => {
    renderRailArm('control', () => {});

    const controlButton = screen.getByRole('button', { name: 'Control arm, selected' });
    expect(controlButton).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Live arm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Live arm, selected' })).toBeNull();

    expect(within(controlButton).getByText('· selected')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'Live arm' })).queryByText('· selected'),
    ).toBeNull();
  });

  it('is reachable and operable by keyboard — a native button needs no roving tabindex', () => {
    const onArm = vi.fn();
    renderRailArm('live', onArm);

    const control = screen.getByRole('button', { name: 'Control arm' });
    control.focus();
    expect(document.activeElement).toBe(control);
    fireEvent.click(control);
    expect(onArm).toHaveBeenCalledWith('control');
  });

  it('calls onArm with the clicked arm, not the current one', () => {
    const onArm = vi.fn();
    renderRailArm('control', onArm);

    fireEvent.click(screen.getByRole('button', { name: 'Live arm' }));
    expect(onArm).toHaveBeenCalledWith('live');
    expect(onArm).not.toHaveBeenCalledWith('control');
  });
});

/**
 * #1597: the control arm is wired with its own in-memory
 * `InMemoryCurrentTickStore` and never writes `tick_status` — the Live tick
 * tile names that structural absence rather than reading it as "idle" (a
 * quiet moment a control snapshot's `tick_status: null` would otherwise be
 * indistinguishable from).
 */
describe('Rail — control arm', () => {
  it('names the tick absence as structural rather than reading the control arm as idle', () => {
    renderRail(makeFeed({ snapshot: makeSnapshot({ arm: 'control' }) }));

    expect(screen.getByText('Control arm: tick status is not persisted')).toBeTruthy();
    expect(screen.queryByText(/idle — no tick in progress/)).toBeNull();
  });

  it('still reads a real live tick on the live arm', () => {
    renderRail(makeFeed({ snapshot: makeSnapshot({ arm: 'live' }) }));

    expect(screen.getByText(/idle — no tick in progress/)).toBeTruthy();
    expect(screen.queryByText(/tick status is not persisted/)).toBeNull();
  });
});

/**
 * dashboard-spec.md's arm selector rule: "Providers, LLM spend and alert
 * delivery render identically in both views, labelled as system" (#1597).
 * The label itself, not the figures beneath it, is what this suite pins —
 * the figures were already arm-indifferent before this ticket, since the
 * wire never scoped them; what was missing was the word telling an operator
 * that a switch will not change them.
 */
describe('Rail — system facts', () => {
  it('labels Providers, LLM cap and a shown alert-channel tile as system, on both arms', () => {
    for (const arm of ['live', 'control'] as const) {
      const { unmount } = renderRail(
        makeFeed({ snapshot: makeSnapshot({ arm, alert_delivery_failures_24h: 2 }) }),
      );
      expect(screen.getAllByText('system — identical in both arms').length).toBe(3);
      unmount();
    }
  });

  it('carries no system label on the per-arm Drawdown tile', () => {
    renderRail(makeFeed({ snapshot: makeSnapshot({ arm: 'live' }) }));
    const drawdown = screen.getByText('Drawdown').closest('[data-field="drawdown"]');
    expect(drawdown).toBeTruthy();
    expect(within(drawdown as HTMLElement).queryByText(/system — identical/)).toBeNull();
  });

  /**
   * `SpendBlock`'s `SystemTag` lives inside `CapMeter`'s `footnote` callback,
   * which `CapMeter` calls unconditionally regardless of `capReasonOf` —  but
   * that independence is worth pinning directly: a `reason` other than
   * `'capped'` (the only one the suite above's default fixture exercises)
   * takes the meter's `emptyState` branch instead of drawing a `Track`, and a
   * future change to that branch must not walk the tag out with it.
   */
  it('still labels the LLM cap tile as system when the cap is uncapped, not drawn as a meter', () => {
    renderRail(
      makeFeed({
        snapshot: makeSnapshot({
          arm: 'live',
          llm_spend: makeSpend({ cap_usd: null, cap_armed_at: '2026-08-05T14:00:00.000Z' }),
        }),
      }),
    );
    const cap = screen.getByText('LLM cap').closest('[data-field="llm-cap"]');
    expect(cap).toBeTruthy();
    expect(within(cap as HTMLElement).getByText(/meter not drawable/)).toBeTruthy();
    expect(within(cap as HTMLElement).getByText('system — identical in both arms')).toBeTruthy();
  });
});
