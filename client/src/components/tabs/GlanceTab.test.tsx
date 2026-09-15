// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makePnlHeadline, makePosition, makeSnapshot } from '../../test-fixtures.ts';
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

describe('P&L', () => {
  it('renders overall beside its drawdown and trade count, and today beside its breakdown, from the wire headline, in GBP', () => {
    renderGlance(
      makeSnapshot({
        pnl: makePnlHeadline({
          overall: {
            net_gbp: 42.5,
            net_pct_of_book: 0.0425,
            max_drawdown_pct: 0.018,
            trade_count: 43,
          },
          today: {
            net_gbp: 3.3,
            net_pct_of_book: 0.0033,
            realized_gbp: 1.8,
            unrealized_gbp: 1.5,
            costs_gbp: 0.2,
            trade_count: 2,
          },
          rate_usd_per_gbp: 1.27,
          rate_source: 'static_sizing_rate',
        }),
      }),
    );
    const card = screen.getByRole('region', { name: 'P&L' });
    expect(within(card).getByText('+£42.50')).toBeTruthy();
    expect(within(card).getByText('+4.25% of the £1,000 book')).toBeTruthy();
    expect(within(card).getByText('1.8%')).toBeTruthy();
    expect(within(card).getByText('43')).toBeTruthy();
    expect(within(card).getByText('+£3.30')).toBeTruthy();
    expect(within(card).getByText('+0.33% of the £1,000 book')).toBeTruthy();
    expect(within(card).getByText('+£1.80')).toBeTruthy();
    expect(within(card).getByText('+£1.50')).toBeTruthy();
    expect(within(card).getByText('−£0.20')).toBeTruthy();
    expect(within(card).getByText('at $1.27/£, static sizing rate')).toBeTruthy();
  });

  it('captions Overall, not Today, with the Review arm-comparison divergence caveat (#1623)', () => {
    renderGlance(makeSnapshot());
    const card = screen.getByRole('region', { name: 'P&L' });
    const caveat = within(card).getByText(
      'All-time, every closed trade — the Review arm-comparison panel uses a filtered, narrower window sampled on its own cadence, and can report a different figure for the same arm.',
    );
    const overallBlock = within(card).getByText('Overall').closest('.pnl-block');
    expect(overallBlock?.contains(caveat)).toBe(true);
  });

  it('states the declared book from the wire, not a client literal (#1620)', () => {
    renderGlance(
      makeSnapshot({
        pnl: makePnlHeadline({
          overall: {
            net_gbp: 42.5,
            net_pct_of_book: 0.0425,
            max_drawdown_pct: 0.018,
            trade_count: 43,
          },
          book_gbp: 2_000,
        }),
      }),
    );
    const card = screen.getByRole('region', { name: 'P&L' });
    expect(within(card).getByText('+4.25% of the £2,000 book')).toBeTruthy();
    expect(within(card).queryByText(/£1,000 book/)).toBeNull();
  });

  it('shows a negative overall net beside its drawdown, tone included, never a return without its drawdown', () => {
    renderGlance(
      makeSnapshot({
        pnl: makePnlHeadline({
          overall: {
            net_gbp: -18,
            net_pct_of_book: -0.018,
            max_drawdown_pct: 0.092,
            trade_count: 12,
          },
        }),
      }),
    );
    const card = screen.getByRole('region', { name: 'P&L' });
    const overall = within(card).getByText('−£18.00');
    expect(overall.className).toContain('loss');
    expect(within(card).getByText('9.2%')).toBeTruthy();
  });

  it('labels Alpaca equity separately on the live arm, alongside its probe sparkline', () => {
    renderGlance(makeSnapshot({ arm: 'live' }), [100, 101]);
    const card = screen.getByRole('region', { name: 'P&L' });
    expect(within(card).getByText('Alpaca equity: $100,112.98')).toBeTruthy();
    expect(
      within(card).getByRole('img', { name: /Alpaca equity observed this session: 2 samples/ }),
    );
  });

  it('says Alpaca equity is unavailable on the live arm rather than rendering nothing', () => {
    const snapshot = makeSnapshot({ arm: 'live' });
    snapshot.providers.alpaca = { ...snapshot.providers.alpaca, balance: null };
    renderGlance(snapshot);
    expect(screen.getByText('Alpaca equity unavailable')).toBeTruthy();
  });

  it('names the control arm’s absent equity figure and drops the sparkline entirely', () => {
    renderGlance(makeSnapshot({ arm: 'control' }));
    const card = screen.getByRole('region', { name: 'P&L' });
    expect(within(card).getByText('Control arm: simulated broker — no equity figure')).toBeTruthy();
    expect(within(card).queryByText(/Alpaca equity/)).toBeNull();
    expect(within(card).queryByRole('img', { name: /Alpaca equity observed/ })).toBeNull();
  });

  it('names an absent headline instead of drawing £0.00', () => {
    const snapshot = makeSnapshot({ pnl: null });
    renderGlance(snapshot);
    expect(
      screen.getByText('No P&L headline on this snapshot — the server did not include one.'),
    ).toBeTruthy();
  });

  it('names the equity line’s empty state until two probe observations exist', () => {
    renderGlance(makeSnapshot({ arm: 'live' }), [100]);
    expect(screen.getByText(/one distinct observation so far/)).toBeTruthy();
    renderGlance(makeSnapshot({ arm: 'live' }), [100, 101]);
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

  /**
   * #1597: Alpaca is the LIVE broker, so its equity is a live-arm-only figure
   * (dashboard-spec.md's arm selector rule). The deployed-notional half comes
   * from `positions`, which IS arm-scoped, and still renders.
   */
  it('names the control arm’s absent equity denominator rather than Alpaca’s', () => {
    renderGlance(
      makeSnapshot({
        arm: 'control',
        positions: [makePosition({ filled_size: 18, mark_price: 100 })],
      }),
    );
    const card = screen.getByRole('region', { name: 'Open risk' });
    expect(
      within(card).getByText(
        /\$1,800\.00 deployed · Control arm: simulated broker — no equity figure/,
      ),
    ).toBeTruthy();
    expect(within(card).queryByText(/of \$100,112\.98/)).toBeNull();
  });
});
