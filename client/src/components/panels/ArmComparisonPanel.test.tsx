// @vitest-environment jsdom
//
// #971 / #913 surface 2. Two properties, and the second is the one that
// matters: the panel renders BOTH arms with return AND drawdown, and there is
// no branch anywhere in it that can render a return alone. `docs/research/
// 12-edge-hypothesis-critique.md` D4 rules out a return-only comparison against
// a risk-targeted stream; #753's AC5 held that line at the CLI surface, and
// this file holds it at the dashboard surface.

import type { ArmPerformanceWire } from '@contracts';
import { render, screen, within } from '@testing-library/react';
// Explicit, unlike the server suite: `client/tsconfig.test.json` extends
// `client/tsconfig.json`, whose `types` is `["vite/client"]` — `vitest/globals`
// is on the ROOT `tsconfig.test.json` only, so under `yarn typecheck` these
// names are unresolvable in a `client/` test without this import. Same as
// `PositionsPanel.test.tsx` and `ClosedTradesPanel.test.tsx`.
import { describe, expect, it } from 'vitest';
import { makeArmComparison } from '../../test-fixtures.ts';
import { ArmComparisonPanel } from './ArmComparisonPanel.tsx';

describe('ArmComparisonPanel', () => {
  it('renders both arms with return and drawdown together', () => {
    render(
      <ArmComparisonPanel
        comparisons={[
          makeArmComparison({
            live: {
              arm: 'live',
              trade_count: 24,
              realized_pnl_net: 18.4,
              return_pct: 0.0184,
              max_drawdown_pct: 0.021,
            },
            control: {
              arm: 'control',
              trade_count: 19,
              realized_pnl_net: 6.2,
              return_pct: 0.0062,
              max_drawdown_pct: 0.028,
            },
          }),
        ]}
      />,
    );

    const panel = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(panel).getByText('live (debate)')).toBeTruthy();
    expect(within(panel).getByText('control (arm 2)')).toBeTruthy();
    expect(within(panel).getByText('return 1.84%')).toBeTruthy();
    expect(within(panel).getByText('max drawdown 2.10%')).toBeTruthy();
    expect(within(panel).getByText('return 0.62%')).toBeTruthy();
    expect(within(panel).getByText('max drawdown 2.80%')).toBeTruthy();
  });

  /**
   * The AC5-shaped assertion, at the level a renderer can actually break it:
   * every rendered return figure has a drawdown figure beside it in the same
   * row. A future edit that drops the drawdown column fails here even though
   * the wire type still requires the field.
   */
  it('never renders a return without a drawdown beside it', () => {
    render(<ArmComparisonPanel comparisons={[makeArmComparison()]} />);

    const panel = screen.getByRole('region', { name: 'Arm comparison' });
    const rows = panel.querySelectorAll('.arm-row');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.textContent).toMatch(/return -?\d+\.\d+%/);
      expect(row.textContent).toMatch(/max drawdown -?\d+\.\d+%/);
    }
  });

  it('states the divergence reason when the arms have diverged', () => {
    render(
      <ArmComparisonPanel
        comparisons={[
          makeArmComparison({
            diverged: true,
            divergence_reason: 'the control arm is ahead by 1.20% of the book over this window',
          }),
        ]}
      />,
    );

    const panel = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(panel).getByText(/DIVERGED: the control arm is ahead by 1\.20%/)).toBeTruthy();
  });

  /**
   * `diverged: false` covers two different states, and #982 put the floor on
   * the wire so the panel can name which one it is looking at rather than
   * softening its copy to cover both.
   */
  describe('the two diverged:false states, now distinguishable (#982)', () => {
    /**
     * Below the floor on either arm: dominance was never tested at all, so the
     * panel must not claim the control failed to dominate — that claim is false
     * here, it was simply never evaluated.
     */
    it('states the trade counts against the floor when below it, and makes no dominance claim', () => {
      render(
        <ArmComparisonPanel
          comparisons={[
            makeArmComparison({
              diverged: false,
              min_trades_per_arm: 5,
              live: {
                arm: 'live',
                trade_count: 3,
                realized_pnl_net: 1.1,
                return_pct: 0.0011,
                max_drawdown_pct: 0.004,
              },
              control: {
                arm: 'control',
                trade_count: 19,
                realized_pnl_net: 6.2,
                return_pct: 0.0062,
                max_drawdown_pct: 0.028,
              },
            }),
          ]}
        />,
      );

      const panel = screen.getByRole('region', { name: 'Arm comparison' });
      expect(within(panel).getByText(/the floor is 5 per arm/)).toBeTruthy();
      expect(within(panel).getByText(/live 3, control 19/)).toBeTruthy();
      expect(within(panel).getByText(/Not enough closed trades yet for a verdict/)).toBeTruthy();
      expect(within(panel).queryByText(/is not ahead of the live arm/)).toBeNull();
    });

    /**
     * At or above the floor on both arms: dominance WAS tested and the control
     * did not win, so the panel can now make the claim #979 had to withdraw —
     * provably true, since surfacing the floor is what makes this branch only
     * reachable when the test actually ran.
     */
    it('claims the control did not dominate once both arms clear the floor', () => {
      render(
        <ArmComparisonPanel
          comparisons={[
            makeArmComparison({
              diverged: false,
              min_trades_per_arm: 5,
              live: {
                arm: 'live',
                trade_count: 24,
                realized_pnl_net: 18.4,
                return_pct: 0.0184,
                max_drawdown_pct: 0.021,
              },
              control: {
                arm: 'control',
                trade_count: 19,
                realized_pnl_net: 6.2,
                return_pct: 0.0062,
                max_drawdown_pct: 0.028,
              },
            }),
          ]}
        />,
      );

      const panel = screen.getByRole('region', { name: 'Arm comparison' });
      expect(
        within(panel).getByText(/Did not diverge: the control is not ahead of the live arm/),
      ).toBeTruthy();
      expect(within(panel).queryByText(/not enough closed trades yet/i)).toBeNull();
    });
  });

  /** Zeros would read as "both arms flat"; the honest empty state says nothing was computed. */
  it('says no comparison has been computed rather than drawing zeros', () => {
    render(<ArmComparisonPanel comparisons={[]} />);

    const panel = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(panel).getByText(/has not computed a comparison yet/)).toBeTruthy();
    expect(within(panel).queryByText(/max drawdown/)).toBeNull();
  });

  it('carries the converged-control asymmetry onto the panel', () => {
    render(<ArmComparisonPanel comparisons={[makeArmComparison()]} />);

    expect(screen.getByText(/always treated as\s+converged/)).toBeTruthy();
  });

  it('plots the trend across cycles, both columns per point', () => {
    render(
      <ArmComparisonPanel
        comparisons={[
          makeArmComparison({ computed_at: '2026-08-08T12:00:00.000Z' }),
          makeArmComparison({ computed_at: '2026-08-07T12:00:00.000Z' }),
        ]}
      />,
    );

    const points = screen
      .getByRole('region', { name: 'Arm comparison' })
      .querySelectorAll('.arm-trend li');
    expect(points.length).toBe(2);
    for (const point of points) {
      expect(point.textContent).toMatch(/live .*dd/);
      expect(point.textContent).toMatch(/control .*dd/);
    }
  });

  /**
   * The trend list renders many historical rows at once, and without a
   * per-row marker a below-floor row is pixel-identical to a
   * tested-and-did-not-diverge row — both are `diverged: false` (#982). Each
   * point is checked against its OWN `min_trades_per_arm`, not the latest
   * row's, so this also proves the floor is read per row rather than once.
   */
  it('marks a below-floor point in the trend distinctly from a tested one', () => {
    render(
      <ArmComparisonPanel
        comparisons={[
          makeArmComparison({
            computed_at: '2026-08-08T12:00:00.000Z',
            diverged: false,
            min_trades_per_arm: 5,
            live: {
              arm: 'live',
              trade_count: 24,
              realized_pnl_net: 18.4,
              return_pct: 0.0184,
              max_drawdown_pct: 0.021,
            },
            control: {
              arm: 'control',
              trade_count: 19,
              realized_pnl_net: 6.2,
              return_pct: 0.0062,
              max_drawdown_pct: 0.028,
            },
          }),
          makeArmComparison({
            computed_at: '2026-08-07T12:00:00.000Z',
            diverged: false,
            min_trades_per_arm: 5,
            live: {
              arm: 'live',
              trade_count: 2,
              realized_pnl_net: 0.4,
              return_pct: 0.0004,
              max_drawdown_pct: 0.001,
            },
            control: {
              arm: 'control',
              trade_count: 19,
              realized_pnl_net: 6.2,
              return_pct: 0.0062,
              max_drawdown_pct: 0.028,
            },
          }),
        ]}
      />,
    );

    const points = screen
      .getByRole('region', { name: 'Arm comparison' })
      .querySelectorAll('.arm-trend li');
    expect(points.length).toBe(2);

    const [tested, belowFloor] = points;
    expect(tested?.className).not.toMatch(/below-floor/);
    expect(tested?.textContent).not.toMatch(/below floor/);

    expect(belowFloor?.className).toContain('arm-trend-below-floor');
    expect(belowFloor?.textContent).toMatch(/below floor/);
  });

  /**
   * A diverged row proves both arms cleared the floor, by construction of
   * `evaluateArmDivergence` — so even if a caller passed a fixture with a low
   * trade count alongside `diverged: true`, the panel must key off `diverged`
   * first and never paint a diverged point as below-floor.
   */
  it('never marks a diverged trend point as below the floor', () => {
    render(
      <ArmComparisonPanel
        comparisons={[
          makeArmComparison({
            computed_at: '2026-08-08T12:00:00.000Z',
            diverged: true,
            divergence_reason: 'the control arm is ahead by 1.20% of the book',
            min_trades_per_arm: 5,
          }),
          makeArmComparison({ computed_at: '2026-08-07T12:00:00.000Z' }),
        ]}
      />,
    );

    const [diverged] = screen
      .getByRole('region', { name: 'Arm comparison' })
      .querySelectorAll('.arm-trend li');
    expect(diverged?.className).toContain('arm-trend-diverged');
    expect(diverged?.className).not.toMatch(/below-floor/);
    expect(diverged?.textContent).not.toMatch(/below floor/);
  });
});

describe('the wire contract itself', () => {
  /**
   * The structural half of the same guarantee (#753 AC5, mirrored at the wire):
   * an arm performance value with the drawdown omitted does not typecheck, so a
   * return-only per-arm view cannot be constructed anywhere — panel, test, or
   * future consumer.
   */
  it('refuses an arm without a drawdown', () => {
    const arm: ArmPerformanceWire = {
      arm: 'live',
      trade_count: 1,
      realized_pnl_net: 1,
      return_pct: 0.001,
      max_drawdown_pct: 0.001,
    };
    expect(arm.max_drawdown_pct).toBe(0.001);

    // @ts-expect-error — `max_drawdown_pct` is required: a return-only arm view
    // is not expressible on this contract (doc 12 D4).
    const returnOnly: ArmPerformanceWire = {
      arm: 'control',
      trade_count: 1,
      realized_pnl_net: 1,
      return_pct: 0.001,
    };
    expect(returnOnly.return_pct).toBe(0.001);
  });
});
