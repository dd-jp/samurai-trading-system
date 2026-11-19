// @vitest-environment jsdom
import type { CrossSleeveExposureWire } from '@contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExposurePanel } from './ExposurePanel.tsx';

const DEBATE_AAPL = {
  book_id: 'debate/primary',
  sleeve_id: 'debate',
  instrument: 'AAPL',
  signed_gbp: -300,
};
const SIGNALS_AAPL = {
  book_id: 'signals/primary',
  sleeve_id: 'signals',
  instrument: 'AAPL',
  signed_gbp: 500,
};

const REPORT: CrossSleeveExposureWire = {
  trading_date: '2026-11-19',
  window_returns: 60,
  min_observations: 20,
  overlap_warn: 1,
  correlation_warn: 0.7,
  books: [
    {
      book_id: 'debate/primary',
      sleeve_id: 'debate',
      variant: 'primary',
      long_gbp: 0,
      short_gbp: 300,
      gross_gbp: 300,
      net_gbp: -300,
    },
  ],
  holdings: [DEBATE_AAPL, SIGNALS_AAPL],
  overlaps: [
    {
      instrument: 'AAPL',
      sleeves: ['debate', 'signals'],
      opposed: true,
      holders: [DEBATE_AAPL, SIGNALS_AAPL],
    },
  ],
  correlations: [
    {
      book_a: 'debate/primary',
      book_b: 'signals/primary',
      cross_sleeve: true,
      correlation: null,
      observations: 4,
      gap: 'warm_up',
    },
    {
      book_a: 'signals/no-veto',
      book_b: 'signals/primary',
      cross_sleeve: false,
      correlation: 0.987,
      observations: 30,
      gap: null,
    },
  ],
  warnings: ['overlap:AAPL'],
};

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Cross-sleeve exposure' });
}

describe('ExposurePanel', () => {
  it('shows each book, each shared name and each pair, with the warnings', () => {
    render(<ExposurePanel panel={{ status: 'fed', ...REPORT }} />);
    const rows = [...region().querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual([
      'debate/primary£0.00£300.00£300.00−£300.00',
      'AAPLdebate, signalsopposeddebate/primary −£300.00; signals/primary £500.00',
      'debate/primary / signals/primaryyeswarming up 4/20',
      'signals/no-veto / signals/primaryno0.99',
    ]);
    expect(region().textContent).toContain('Warnings: overlap:AAPL');
  });

  it('says a pair with a flat book has no correlation rather than showing 0', () => {
    const correlations = REPORT.correlations.map((pair) => ({
      ...pair,
      gap: 'zero_variance' as const,
    }));
    render(<ExposurePanel panel={{ status: 'fed', ...REPORT, correlations }} />);
    expect(region().textContent).toContain('a book did not move');
  });

  it('says when no name is shared and when no report exists yet', () => {
    const { unmount } = render(
      <ExposurePanel panel={{ status: 'fed', ...REPORT, overlaps: [], warnings: [] }} />,
    );
    expect(region().textContent).toContain('No instrument held by more than one sleeve.');
    expect(region().textContent).not.toContain('Warnings');
    unmount();
    render(<ExposurePanel panel={{ status: 'empty' }} />);
    expect(region().textContent).toContain('No exposure report yet.');
  });
});
