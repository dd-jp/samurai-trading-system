// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeClosedTrade, makePosition, makeSnapshot } from '../../test-fixtures.ts';
import { GlanceTab } from './GlanceTab.tsx';

function renderGlance(snapshot: ReturnType<typeof makeSnapshot>, equity: number[] = []) {
  return render(
    <GlanceTab
      snapshot={snapshot}
      equitySamples={equity.map((value, index) => ({ observed_at: `t${index}`, equity: value }))}
      ledger={[]}
      verdictsByTrace={new Map()}
      onOpenTrace={() => {}}
    />,
  );
}

describe('P&L today', () => {
  it('leads with today’s total, signed, against Alpaca equity', () => {
    renderGlance(
      makeSnapshot({
        positions: [makePosition({ unrealized_pnl: 10 })],
        closed_trades: [makeClosedTrade({ realized_pnl_net: -4, fees_total: 1 })],
      }),
    );
    const card = screen.getByRole('region', { name: 'P&L today' });
    expect(within(card).getByText('+$6.00')).toBeTruthy();
    expect(within(card).getByText(/\+0\.01% of \$100,112\.98 equity/)).toBeTruthy();
    expect(within(card).getByText('−$4.00')).toBeTruthy();
    expect(within(card).getByText('+$10.00')).toBeTruthy();
    expect(within(card).getByText('−$1.00')).toBeTruthy();
    expect(within(card).getByText('1 closed · 1 open')).toBeTruthy();
  });

  it('says the book figure is missing rather than dividing by nothing', () => {
    const snapshot = makeSnapshot();
    snapshot.providers.alpaca = { ...snapshot.providers.alpaca, balance: null };
    renderGlance(snapshot);
    expect(screen.getByText(/Alpaca equity unavailable/)).toBeTruthy();
  });

  it('names the equity line’s empty state until two probe observations exist', () => {
    renderGlance(makeSnapshot(), [100]);
    expect(screen.getByText(/one distinct observation so far/)).toBeTruthy();
    renderGlance(makeSnapshot(), [100, 101]);
    expect(screen.getByRole('img', { name: /Alpaca equity observed this session: 2 samples/ }));
  });
});

describe('open risk', () => {
  it('shows each position’s notional, stop distance and target with a word for each', () => {
    renderGlance(
      makeSnapshot({
        positions: [
          makePosition({
            instrument: '3LUS',
            side: 'buy',
            filled_size: 18,
            mark_price: 100,
            stop: 95,
            target: 110,
            unrealized_pnl: 14.62,
          }),
        ],
      }),
    );
    const card = screen.getByRole('region', { name: 'Open risk' });
    expect(within(card).getByText(/\$1,800\.00 deployed of \$100,112\.98/)).toBeTruthy();
    expect(within(card).getByText(/long 18 · \$1,800\.00 · mark 100\.00/)).toBeTruthy();
    expect(within(card).getByText(/stop 95\.00 · 5\.0% away/)).toBeTruthy();
    expect(within(card).getByText('target 110.00')).toBeTruthy();
    expect(within(card).getByText('+$14.62')).toBeTruthy();
    expect(within(card).getByRole('img', { name: /33% of the way from stop to target/ }));
  });

  it('says "through" when the mark is past the stop', () => {
    renderGlance(
      makeSnapshot({
        positions: [makePosition({ side: 'buy', mark_price: 90, stop: 95, target: 110 })],
      }),
    );
    expect(screen.getByText(/5\.6% through/)).toBeTruthy();
  });

  it('names an empty book rather than drawing nothing', () => {
    renderGlance(makeSnapshot({ positions: [] }));
    expect(screen.getByText(/No open position — nothing at risk/)).toBeTruthy();
  });
});
