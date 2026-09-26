// @vitest-environment jsdom
import type { DecisionWire } from '@contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionsPanel } from './DecisionsPanel.tsx';

const BASE: DecisionWire = {
  book_id: 'debate/primary',
  trading_date: '2026-10-05',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'long',
  action: 'enter_long',
  vetoed: false,
  reason: 'consensus',
  confidence: 0.71,
};

function text() {
  return screen.getByRole('region', { name: "Today's decisions" }).textContent ?? '';
}

describe('DecisionsPanel (P4)', () => {
  it('shows each decision with its outcome, confidence and reason', () => {
    render(
      <DecisionsPanel
        panel={{
          status: 'fed',
          trading_date: '2026-10-05',
          decisions: [
            BASE,
            { ...BASE, instrument: 'MSFT', action: 'enter_short', direction: 'short' },
            { ...BASE, instrument: 'NVDA', action: 'skip', vetoed: true, reason: 'vetoed: macro' },
            { ...BASE, instrument: 'TSLA', action: 'skip', reason: 'no edge' },
            { ...BASE, instrument: 'SPY', action: 'none', reason: 'flat' },
          ],
        }}
      />,
    );
    expect(text()).toContain('Cycle 2026-10-05, primary books');
    expect(
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('data-outcome')),
    ).toEqual(['entered long', 'entered short', 'vetoed', 'skipped', 'none']);
    expect(screen.getByRole('row', { name: /AAPL/ }).textContent).toBe(
      'AAPL longdebate/primaryentered long71%consensus',
    );
  });

  it('says nothing is recorded when empty, and names the owner when not yet fed', () => {
    const { rerender } = render(<DecisionsPanel panel={{ status: 'empty' }} />);
    expect(text()).toContain('No decisions recorded yet.');
    rerender(<DecisionsPanel panel={{ status: 'not-yet-fed', owner: 'x', ticket: '#2' }} />);
    expect(text()).toContain('Not yet fed: x (#2).');
  });
});
