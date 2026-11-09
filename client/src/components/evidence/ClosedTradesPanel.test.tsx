// @vitest-environment jsdom
import type { ClosedTradeLedgerWire } from '@contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClosedTradesPanel } from './ClosedTradesPanel.tsx';

const LEDGER: ClosedTradeLedgerWire = {
  stats: [
    {
      book_id: 'debate/primary',
      trades: 4,
      win_rate: 0.5,
      expectancy_gbp: 2.5,
      profit_factor: 1.5,
      net_gbp: 10,
    },
  ],
  newest: [
    {
      decision_id: 'd-1',
      book_id: 'debate/primary',
      instrument: 'AAPL',
      direction: 'short',
      entry_date: '2026-10-02',
      exit_date: '2026-10-05',
      exit_reason: 'stop',
      holding_days: 3,
      realised_pnl_gbp: -12.5,
      trade_return: -0.05,
      r_multiple: null,
      benchmark_symbol: 'SPY',
      excess_return: -0.06,
    },
  ],
};

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Closed trades' });
}

describe('ClosedTradesPanel', () => {
  it('shows the book totals and each trade', () => {
    render(<ClosedTradesPanel panel={{ status: 'fed', ...LEDGER }} />);
    const [stats, trades] = [...region().querySelectorAll('tbody tr')];
    expect(stats?.textContent).toBe('debate/primary450%£2.501.50£10.00');
    expect(trades?.textContent).toBe(
      'AAPL shortdebate/primary2026-10-02 to 2026-10-05, 3 dstop−£12.50−5.0%—−6.0% SPY',
    );
  });

  it('says no losses instead of an infinite profit factor', () => {
    const stats = LEDGER.stats.map((book) => ({ ...book, profit_factor: null }));
    render(<ClosedTradesPanel panel={{ status: 'fed', ...LEDGER, stats }} />);
    expect(region().textContent).toContain('no losses');
  });

  it('says so when nothing has settled', () => {
    render(<ClosedTradesPanel panel={{ status: 'empty' }} />);
    expect(region().textContent).toContain('No closed trades settled yet.');
  });
});
