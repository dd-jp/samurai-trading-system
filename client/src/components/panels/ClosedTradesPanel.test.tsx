// @vitest-environment jsdom
//
// #940: a trade that entered, filled and flattened had no visible trace
// anywhere on the dashboard. This panel is that trace — pinning that a closed
// trade renders its entry/exit/PnL/fees/timestamps/close_reason, and that its
// fills are matched to the right card by idempotency_key rather than dumped
// in one shared list.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeClosedTrade, makeFill } from '../../test-fixtures.ts';
import { ClosedTradesPanel } from './ClosedTradesPanel.tsx';

describe('ClosedTradesPanel', () => {
  it('renders every datum the ticket asks for on one card', () => {
    render(
      <ClosedTradesPanel
        trades={[
          makeClosedTrade({
            idempotency_key: 'key-1',
            instrument: 'SPY',
            side: 'buy',
            entry_price: 552.1,
            exit_price: 559.8,
            filled_size: 20,
            realized_pnl_net: 151.6,
            fees_total: 2.4,
            opened_at: '2026-08-07T06:30:00.000Z',
            closed_at: '2026-08-07T08:00:00.000Z',
            close_reason: 'target',
          }),
        ]}
        fills={[]}
      />,
    );

    const panel = screen.getByRole('region', { name: 'Closed trades' });
    expect(within(panel).getByText('SPY')).toBeTruthy();
    expect(within(panel).getByText('long')).toBeTruthy();
    expect(within(panel).getByText(/×20\.0000 · stocks/)).toBeTruthy();
    expect(within(panel).getByText('target hit')).toBeTruthy();
    // The PnL sign is explicit, not only a colour — same contract as PositionsPanel.
    expect(within(panel).getByText('+$151.60')).toBeTruthy();
    expect(within(panel).getByText(/entry 552\.10/)).toBeTruthy();
    expect(within(panel).getByText(/exit 559\.80/)).toBeTruthy();
    expect(within(panel).getByText(/fees 2\.40/)).toBeTruthy();
    expect(within(panel).getByText(/opened 06:30:00Z/)).toBeTruthy();
    expect(within(panel).getByText(/closed 08:00:00Z/)).toBeTruthy();
  });

  it('renders a loss with the minus sign, not just a colour', () => {
    render(
      <ClosedTradesPanel
        trades={[
          makeClosedTrade({
            idempotency_key: 'key-2',
            instrument: 'QQQ',
            side: 'sell',
            realized_pnl_net: -69.3,
            close_reason: 'stop',
          }),
        ]}
        fills={[]}
      />,
    );

    expect(screen.getByText('−$69.30')).toBeTruthy();
    expect(screen.getByText('stop hit')).toBeTruthy();
    expect(screen.getByText('short')).toBeTruthy();
  });

  it("matches each trade's fills by idempotency_key, not by rendering every fill on every card", () => {
    render(
      <ClosedTradesPanel
        trades={[
          makeClosedTrade({ idempotency_key: 'key-A', instrument: 'AAA' }),
          makeClosedTrade({ idempotency_key: 'key-B', instrument: 'BBB' }),
        ]}
        fills={[
          makeFill({ idempotency_key: 'key-A', broker_fill_id: 'fill-A-entry', leg: 'entry' }),
          makeFill({ idempotency_key: 'key-A', broker_fill_id: 'fill-A-target', leg: 'target' }),
          makeFill({ idempotency_key: 'key-B', broker_fill_id: 'fill-B-entry', leg: 'entry' }),
        ]}
      />,
    );

    const cards = screen.getAllByRole('listitem');
    const cardA = cards.find((card) => within(card).queryByText('AAA') !== null);
    const cardB = cards.find((card) => within(card).queryByText('BBB') !== null);
    if (cardA === undefined || cardB === undefined) throw new Error('expected both trade cards');

    expect(within(cardA).getByText('fill-A-entry')).toBeTruthy();
    expect(within(cardA).getByText('fill-A-target')).toBeTruthy();
    expect(within(cardA).queryByText('fill-B-entry')).toBeNull();

    expect(within(cardB).getByText('fill-B-entry')).toBeTruthy();
    expect(within(cardB).queryByText('fill-A-entry')).toBeNull();
  });

  it('renders no fills sub-list for a trade with no captured fills', () => {
    render(<ClosedTradesPanel trades={[makeClosedTrade({ idempotency_key: 'key-3' })]} fills={[]} />);

    expect(screen.queryByText(/entry|target|stop|exit/i, { selector: '.trade-fill-leg' })).toBeNull();
  });

  it('states that an empty list is a reading, not a missing panel', () => {
    render(<ClosedTradesPanel trades={[]} fills={[]} />);

    expect(screen.getByText(/No closed trade/)).toBeTruthy();
  });
});
