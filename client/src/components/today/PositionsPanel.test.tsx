// @vitest-environment jsdom
import type { PositionWire } from '@contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { POSITIONS } from '../../test-wire.ts';
import { PositionsPanel } from './PositionsPanel.tsx';

const [AAPL] = POSITIONS.positions as [PositionWire];

function text() {
  return screen.getByRole('region', { name: 'Positions and cash' }).textContent ?? '';
}

describe('PositionsPanel (P3)', () => {
  it('shows each position with its mark, the venue totals, cash and the GBP total', () => {
    render(<PositionsPanel panel={{ status: 'fed', ...POSITIONS }} />);
    expect(screen.getByRole('row', { name: /AAPL/ }).textContent).toBe(
      'AAPL alpacadebate/primary3£150.00£140.00since 2026-10-01, 3 marks$200.00 (2026-10-02)£30.00',
    );
    expect(screen.getByRole('row', { name: 'alpaca $600.00 £480.00' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Total £1,000.00' })).toBeTruthy();
    expect(text()).toContain('USD at 1.2500 per £ (2026, BoE XUDLUSS).');
  });

  it('shows a stale or unavailable mark as such, never as a price, and a missing total', () => {
    render(
      <PositionsPanel
        panel={{
          status: 'fed',
          ...POSITIONS,
          fx: null,
          positions: [
            { ...AAPL, mark: { status: 'stale', bar_date: '2026-09-20' } },
            {
              ...AAPL,
              book_id: 'debate/no-veto',
              variant: 'no-veto',
              stop_gbp: null,
              mark: { status: 'unavailable' },
            },
          ],
          venues: [
            { venue: 'alpaca', currency: 'USD', positions_value_quote: null, positions_value_gbp: null },
          ],
          total_gbp: null,
        }}
      />,
    );
    expect(text()).toContain('stale (last bar 2026-09-20)');
    expect(text()).toContain('no-veto (shadow)');
    expect(text()).toContain('unavailable');
    expect(screen.getByRole('row', { name: 'alpaca — —' })).toBeTruthy();
    expect(text()).toContain('unavailable (a mark is missing)');
    expect(text()).toContain('No GBP/USD rate');
  });

  it('says there are no open positions', () => {
    render(<PositionsPanel panel={{ status: 'fed', ...POSITIONS, positions: [] }} />);
    expect(text()).toContain('No open positions.');
  });

  it('says there are no books when empty, and names the owner when not yet fed', () => {
    const { rerender } = render(<PositionsPanel panel={{ status: 'empty' }} />);
    expect(text()).toContain('No books yet.');
    rerender(<PositionsPanel panel={{ status: 'not-yet-fed', owner: 'bar store', ticket: '#1' }} />);
    expect(text()).toContain('Not yet fed: bar store (#1).');
  });
});
