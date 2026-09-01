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
   * `diverged: false` covers "tested, did not dominate" AND "below the
   * closed-trade floor, never tested" — and the wire does not carry the floor,
   * so the panel cannot tell them apart (#982). It must therefore state the
   * rule rather than assert the stronger claim, which is false in the second
   * case.
   */
  it('does not claim the control failed to dominate when it may never have been tested', () => {
    render(<ArmComparisonPanel comparisons={[makeArmComparison({ diverged: false })]} />);

    const panel = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(panel).getByText(/clear its closed-trade floor/)).toBeTruthy();
    expect(within(panel).queryByText(/is not ahead of the live arm/)).toBeNull();
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
