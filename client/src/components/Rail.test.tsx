// @vitest-environment jsdom
import type { TradingArmWire } from '@contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveFeed } from '../hooks/useSnapshot.ts';
import { makeMetrics, makeSnapshot, makeSpend } from '../test-fixtures.ts';
import { Rail } from './Rail.tsx';

const GENERATED_AT = '2026-08-07T12:00:00.000Z';
const SNAPSHOT_AS_OF = '2026-08-07T11:59:40.000Z';

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
    renderRail(mismatchedFeed({ snapshot: makeSnapshot() }));

    const mismatchTiles = screen.getAllByText('unknown — contract mismatch');
    expect(mismatchTiles.length).toBe(6);
  });

  it('shows a visible alert-channel tile during a mismatch even though the count is 0 — never the silent, no-tile reading a healthy channel gets', () => {
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
    renderRail(mismatchedFeed());

    expect(screen.getByText('MISMATCH')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
    expect(document.querySelector('aside')?.getAttribute('data-stale')).toBe('false');
  });
});

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

  it('says the drawdown figure could not be read when a finite max_drawdown overflows against the tolerance', () => {
    renderRail(
      makeFeed({ snapshot: makeSnapshot({ metrics: makeMetrics({ max_drawdown: 1e308 }) }) }),
    );

    expect(
      screen.getByText('daily suite drawdown figure could not be read — meter not drawable'),
    ).toBeTruthy();
  });
});

describe('Rail — arm selector', () => {
  it('names Live as selected and Control as not, when arm is live', () => {
    renderRailArm('live', () => {});

    const liveButton = screen.getByRole('button', { name: 'Live arm, selected' });
    expect(liveButton).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control arm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Control arm, selected' })).toBeNull();

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
