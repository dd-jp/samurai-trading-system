// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  makeArmComparison,
  makeClosedTrade,
  makeDebate,
  makeFill,
  makeOutsideBenchmark,
  makeRiskCritic,
  makeSnapshot,
  makeVerdict,
} from '../../test-fixtures.ts';
import { ReviewTab } from './ReviewTab.tsx';

function renderReview(
  snapshot: ReturnType<typeof makeSnapshot> | null,
  selectedKey = null as string | null,
) {
  let key = selectedKey;
  const view = render(
    <ReviewTab
      snapshot={snapshot}
      selectedKey={key}
      onSelect={(next) => {
        key = next;
        view.rerender(<ReviewTab snapshot={snapshot} selectedKey={key} onSelect={() => {}} />);
      }}
    />,
  );
  return view;
}

describe('summary cards', () => {
  it('shows the whole metrics suite, both arms with drawdown, and analyst weights numerically', () => {
    renderReview(makeSnapshot());
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    for (const label of [
      'Sharpe',
      'Sortino',
      'Max drawdown',
      'Expectancy',
      'Profit factor',
      'Calmar',
      'Skew',
      'Excess kurtosis',
      'Turnover',
      'Exposure',
      'Observations',
    ]) {
      expect(within(metrics).getByText(label)).toBeTruthy();
    }
    const arms = screen.getByRole('region', { name: 'Arm comparison' });
    expect(arms.querySelector('[data-arm="live"]')).toBeTruthy();
    expect(arms.querySelector('[data-arm="control"]')).toBeTruthy();
    expect(within(arms).getAllByText(/drawdown/).length).toBeGreaterThanOrEqual(2);
    const analysts = screen.getByRole('region', { name: 'Analysts' });
    expect(within(analysts).getByRole('img', { name: /weight \d+%/ })).toBeTruthy();
    expect(within(analysts).getByText(/no per-analyst accuracy/)).toBeTruthy();
    const benchmarks = screen.getByRole('region', { name: 'Outside benchmarks' });
    expect(within(benchmarks).getByText(/secondary context, not the control/)).toBeTruthy();
  });

  it('states the trade floor instead of a verdict when either arm is below it', () => {
    const row = makeArmComparison();
    row.live = { ...row.live, trade_count: 2 };
    row.min_trades_per_arm = 60;
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    expect(screen.getByText(/No verdict until 60 closed trades per arm/)).toBeTruthy();
    expect(screen.queryByText(/Did not diverge/)).toBeNull();
  });

  it('names an unmeasured benchmark rather than drawing it as zero', () => {
    renderReview(makeSnapshot({ outside_benchmarks: [makeOutsideBenchmark()] }));
    expect(screen.getByText(/Not measured this cycle: 60\/40/)).toBeTruthy();
  });

  it('names every missing measurement', () => {
    renderReview(
      makeSnapshot({
        arm_comparison: [],
        outside_benchmarks: [],
        analysts: [],
        metrics: null as never,
      }),
    );
    expect(screen.getByText(/has not computed a comparison yet/)).toBeTruthy();
    expect(screen.getByText(/has not measured an outside benchmark yet/)).toBeTruthy();
    expect(screen.getByText(/No analyst weights on this snapshot/)).toBeTruthy();
    expect(screen.getByText(/No metrics on this snapshot/)).toBeTruthy();
  });
});

describe('closed trades', () => {
  it('lists each trade with its reason word, why it was taken, and a signed P&L', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [
          makeClosedTrade({
            idempotency_key: 'k1',
            debate_id: 'd1',
            close_reason: 'stop',
            realized_pnl_net: -9.4,
          }),
        ],
        debates: [
          makeDebate({ debate_id: 'd1', instrument: 'SPY', direction: 'bullish', rounds: 2 }),
        ],
      }),
    );
    const row = screen.getByRole('button', { name: 'SPY, long, stop hit, −$9.40' });
    expect(within(row).getByText('stop hit')).toBeTruthy();
    expect(
      within(row).getByText(/bullish · 2 rounds · momentum led \(influence 0\.50\)/),
    ).toBeTruthy();
    expect(within(row).getByText('1h 30m')).toBeTruthy();
  });

  it('opens a trade’s drawer with its exact debate, its Risk row by debate_id, its P&L breakdown and fills', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [
          makeClosedTrade({
            idempotency_key: 'k1',
            debate_id: 'd1',
            realized_pnl_net: 8.79,
            fees_total: 2.41,
          }),
        ],
        debates: [makeDebate({ debate_id: 'd1', instrument: 'SPY' })],
        risk_critics: [
          makeRiskCritic({
            debate_id: 'd1',
            trace_id: 'trace-spy',
            instrument: 'SPY',
            critic_verdict: 'pass',
            reasoning: 'measured reclaim',
          }),
          makeRiskCritic({
            debate_id: 'other',
            trace_id: 'trace-other',
            instrument: 'SPY',
            reasoning: 'WRONG ROW',
          }),
        ],
        verdicts: [
          makeVerdict({
            trace_id: 'trace-spy',
            instrument: 'SPY',
            status: 'go',
            reason: 'approved',
          }),
        ],
        fills: [
          makeFill({
            idempotency_key: 'k1',
            leg: 'entry',
            broker_fill_id: 'f-entry',
            price: 552.1,
          }),
          makeFill({ idempotency_key: 'k1', leg: 'target', broker_fill_id: 'f-target' }),
          makeFill({ idempotency_key: 'k2', broker_fill_id: 'f-other' }),
        ],
      }),
    );
    const drawer = screen.getByRole('complementary', { name: 'Trade detail' });
    expect(within(drawer).getByText(/No trade selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^SPY, long/ }));
    expect(within(drawer).getByText('measured reclaim')).toBeTruthy();
    expect(within(drawer).queryByText('WRONG ROW')).toBeNull();
    expect(within(drawer).getByText(/approved · /)).toBeTruthy();
    expect(within(drawer).getByText('+$11.20')).toBeTruthy();
    expect(within(drawer).getByText('−$2.41')).toBeTruthy();
    expect(within(drawer).getAllByText('+$8.79').length).toBeGreaterThan(0);
    const fills = within(drawer).getByRole('list', { name: 'Fills' });
    expect(within(fills).getByText(/f-entry/)).toBeTruthy();
    expect(within(fills).getByText(/f-target/)).toBeTruthy();
    expect(within(fills).queryByText(/f-other/)).toBeNull();
    expect(within(drawer).getByText(/aged out of the 15-minute pipeline window/)).toBeTruthy();
  });

  it('says when no Risk row reaches the trade rather than borrowing the instrument’s', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1' })],
        risk_critics: [makeRiskCritic({ debate_id: 'other', instrument: 'SPY' })],
        debates: [],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^SPY, long/ }));
    const drawer = screen.getByRole('complementary', { name: 'Trade detail' });
    expect(within(drawer).getByText(/No trace id reaches this trade/)).toBeTruthy();
    expect(drawer.querySelector('[data-invalidation="no-decision"]')).toBeTruthy();
    expect(
      within(drawer).getByText(/debate not in the recent-debates window|No completed debate/),
    ).toBeTruthy();
  });

  it('names an empty history', () => {
    renderReview(makeSnapshot({ closed_trades: [] }));
    expect(screen.getByText(/No closed trade in the recent-history window/)).toBeTruthy();
  });
});
