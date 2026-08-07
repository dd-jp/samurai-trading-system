// @vitest-environment jsdom
//
// The price rail is the one place on this page that turns wire numbers into
// CSS geometry, so it is also the one place where a non-finite value would be
// written into a style attribute as `NaN%` — silently collapsing every marker
// onto the left edge, which reads as "this position is at its stop". These
// tests pin the degenerate cases rather than the happy path's exact pixels.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makePosition } from '../../test-fixtures.ts';
import { PositionsPanel } from './PositionsPanel.tsx';

describe('PositionsPanel', () => {
  it('renders every datum the inventory asks for on one row', () => {
    render(<PositionsPanel positions={[makePosition()]} />);

    const panel = screen.getByRole('region', { name: 'Open positions' });
    expect(within(panel).getByText('ETH-USD')).toBeTruthy();
    expect(within(panel).getByText('long')).toBeTruthy();
    expect(within(panel).getByText(/×2\.4000 filled · crypto/)).toBeTruthy();
    // The PnL sign is explicit, not only a colour.
    expect(within(panel).getByText('+$133.68')).toBeTruthy();
    expect(within(panel).getByText(/avg entry 3,412\.50/)).toBeTruthy();
    // Each of these appears twice — once as a rail marker label, once in the
    // meta line under it — so `getAllByText` is the honest query.
    expect(within(panel).getAllByText(/stop 3,310\.00/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/target 3,640\.00/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/mark 3,468\.20/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/state: filled/)).toBeTruthy();
    expect(within(panel).getByText(/opened 11:44:00Z/)).toBeTruthy();
  });

  it('draws the rail with finite percentages only', () => {
    render(<PositionsPanel positions={[makePosition()]} />);

    const rail = screen.getByRole('img', { name: /stop 3,310\.00, entry/ });
    for (const tick of rail.querySelectorAll('.rail-tick')) {
      const left = (tick as HTMLElement).style.left;
      expect(left).not.toContain('NaN');
      expect(Number.parseFloat(left)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(left)).toBeLessThanOrEqual(100);
    }
  });

  it('names its reason instead of drawing a rail from a non-finite price', () => {
    render(<PositionsPanel positions={[makePosition({ mark_price: Number.NaN })]} />);

    expect(screen.getByText(/Price rail not drawable/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    // The numbers still render; the unknown one is the documented em dash.
    expect(screen.getByText(/mark —/)).toBeTruthy();
  });

  it('names its reason when all four prices coincide (a zero-width axis)', () => {
    render(
      <PositionsPanel
        positions={[
          makePosition({ stop: 100, avg_entry_price: 100, mark_price: 100, target: 100 }),
        ]}
      />,
    );

    expect(screen.getByText(/Price rail not drawable/)).toBeTruthy();
  });

  it('renders a non-finite PnL as the documented em dash, never +$NaN', () => {
    render(<PositionsPanel positions={[makePosition({ unrealized_pnl: Number.NaN })]} />);

    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('states that an empty list is a reading, not a missing panel', () => {
    render(<PositionsPanel positions={[]} />);

    expect(screen.getByText(/No open position/)).toBeTruthy();
  });
});
