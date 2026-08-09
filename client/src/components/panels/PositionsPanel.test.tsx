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

  // #540. jsdom has no layout, so an overlap cannot be measured here — what
  // these pin is the geometry that makes an overlap impossible, which is the
  // part a browser screenshot cannot assert either way.
  it('gives each below-rail label its own row, in left-to-right order', () => {
    // A tight stop and a target a hair above the mark: centred labels at
    // `translateX(-50%)` printed over each other exactly here, which is the
    // moment the rail is most worth reading.
    render(
      <PositionsPanel
        positions={[
          makePosition({
            stop: 3_400,
            avg_entry_price: 3_412.5,
            mark_price: 3_418,
            target: 3_425,
          }),
        ]}
      />,
    );

    const rail = screen.getByRole('img', { name: /stop 3,400\.00, entry/ });
    const below = ['stop', 'entry', 'target'].map((key) => {
      const tick = rail.querySelector<HTMLElement>(`.rail-${key}`);
      if (tick === null) throw new Error(`no ${key} marker on the rail`);
      return {
        key,
        left: Number.parseFloat(tick.style.left),
        row: Number.parseInt(tick.style.getPropertyValue('--rail-row'), 10),
      };
    });

    // Three distinct rows: no two below-rail labels can share a line to
    // collide on, whatever the prices do.
    expect(new Set(below.map((marker) => marker.row)).size).toBe(3);
    // And the rows descend in the same direction the prices ascend, so the
    // staircase reads as the rail rather than as an arbitrary shuffle.
    const byPosition = [...below].sort((a, b) => a.left - b.left);
    expect(byPosition.map((marker) => marker.row)).toEqual([0, 1, 2]);

    // The mark keeps the row above the rail to itself.
    const mark = rail.querySelector<HTMLElement>('.rail-mark');
    expect(mark?.style.getPropertyValue('--rail-row')).toBe('0');
  });

  it('anchors the outermost labels to their markers so neither overflows the card', () => {
    render(<PositionsPanel positions={[makePosition()]} />);

    const rail = screen.getByRole('img', { name: /stop 3,310\.00, entry/ });
    // `stop` is the axis minimum (3%) and `target` its maximum (97%): centred,
    // each would hang half a label outside the position card.
    expect(rail.querySelector('.rail-stop .rail-label')?.className).toContain('rail-label-start');
    expect(rail.querySelector('.rail-target .rail-label')?.className).toContain('rail-label-end');
    // An interior marker still centres on the price it names.
    expect(rail.querySelector('.rail-mark .rail-label')?.className).toContain('rail-label-middle');
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
