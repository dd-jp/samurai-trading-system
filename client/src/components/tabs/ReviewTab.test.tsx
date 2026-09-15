// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  makeArmComparison,
  makeClosedTrade,
  makeDebate,
  makeFill,
  makeMetrics,
  makeOutsideBenchmark,
  makeRiskCritic,
  makeSnapshot,
  makeVerdict,
} from '../../test-fixtures.ts';
import { ReviewTab } from './ReviewTab.tsx';

function renderReview(
  snapshot: ReturnType<typeof makeSnapshot>,
  selectedKey: string | null = null,
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

  /**
   * #1180: `basis` is the declared book in the ACCOUNT's currency now, not GBP,
   * and the sigil is the only thing on screen that says which. A `£` here would
   * print a USD figure behind a pound sign — the same denomination mismatch the
   * ticket fixed at the sizing inlet, re-introduced at the one place an operator
   * reads the denominator. The absence assertion is the half that fails on a
   * revert: `formatUsd` gives the digits either way.
   */
  it('renders the arm-comparison basis in the account currency, not GBP (#1180)', () => {
    renderReview(makeSnapshot());
    const arms = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(arms).getByText(/basis \$1,000\.00/)).toBeTruthy();
    expect(within(arms).queryByText(/basis £/)).toBeNull();
  });

  it('states the trade floor instead of a verdict when either arm is below it', () => {
    const row = makeArmComparison();
    row.live = { ...row.live, trade_count: 2 };
    row.min_trades_per_arm = 60;
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    expect(screen.getByText(/No verdict until 60 closed trades per arm/)).toBeTruthy();
    expect(screen.queryByText(/Did not diverge/)).toBeNull();
  });

  it('still says DIVERGED when the reason is missing, rather than reporting no divergence', () => {
    const row = makeArmComparison();
    row.diverged = true;
    row.divergence_reason = null;
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    expect(screen.getByText(/DIVERGED/)).toBeTruthy();
    expect(screen.queryByText(/Did not diverge/)).toBeNull();
  });

  /**
   * #1099/#1483: a `0` refused count renders nothing (there is nothing to
   * report), a positive count is shown, and `null` (a sample from before
   * migration 0057) gets its own note — collapsing `null` into `0` would read
   * as "no refusals" for a window this row never actually measured.
   */
  it('renders nothing for a refused_pass_count of 0', () => {
    const row = makeArmComparison();
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(arms).queryByText(/refused/)).toBeNull();
  });

  it('shows a positive refused_pass_count on the arm it belongs to', () => {
    const row = makeArmComparison();
    row.control = { ...row.control, refused_pass_count: 4 };
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(arms).getByText(/4 refused/)).toBeTruthy();
  });

  /**
   * #1483: `null` is a ROW-level fact (both arms null together, never mixed
   * — a real pre-0057 row has neither column), so the note must appear
   * exactly ONCE per row, not once per arm.
   */
  it('names a pre-migration null refused_pass_count rather than reading it as 0, once per row', () => {
    const row = makeArmComparison();
    row.live = { ...row.live, refused_pass_count: null };
    row.control = { ...row.control, refused_pass_count: null };
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });
    expect(within(arms).getAllByText(/refusals not tracked for this cycle/)).toHaveLength(1);
  });

  /**
   * #1546. The panel is the dashboard's only reader of migration 0065's two
   * columns, so without these the persisted counts would be this repo's
   * dominant defect — a measurement nothing consumes.
   */
  it('shows each arm its own per-exit-class drop rate', () => {
    renderReview(makeSnapshot({ arm_comparison: [makeArmComparison()] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });

    // live: 2 of 18 protective, 6 of 14 flatten. control: none of either.
    expect(within(arms).getByText(/Live arm protective 2\/18 \(11\.1%\)/)).toBeTruthy();
    expect(within(arms).getByText(/flatten 6\/14 \(42\.9%\)/)).toBeTruthy();
    expect(within(arms).getByText(/Control protective 0\/12 \(0\.0%\)/)).toBeTruthy();
  });

  /**
   * A class nothing closed has no rate to report, and `0.0%` would assert one.
   */
  it('reads a class with nothing closed as n/a rather than a zero drop rate', () => {
    const row = makeArmComparison();
    row.live = {
      ...row.live,
      cost_basis_drops: {
        protective: { kept: 4, dropped: 1 },
        flatten: { kept: 0, dropped: 0 },
      },
    };
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });

    expect(within(arms).getByText(/flatten 0\/0 \(n\/a\)/)).toBeTruthy();
  });

  /**
   * Unlike the refused count, an all-zero exclusion is rendered rather than
   * suppressed: "nothing was excluded from this window" is the reading #1412
   * needs, and a block that vanished when it held would be indistinguishable
   * from a row that predates the measurement.
   */
  it('still renders the exclusion block when nothing was dropped', () => {
    const row = makeArmComparison();
    const none = {
      protective: { kept: 9, dropped: 0 },
      flatten: { kept: 4, dropped: 0 },
    };
    row.live = { ...row.live, cost_basis_drops: none };
    row.control = { ...row.control, cost_basis_drops: none };
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });

    expect(within(arms).getByText(/Dropped before these counts/)).toBeTruthy();
    expect(within(arms).queryByText(/not counted for this cycle/)).toBeNull();
  });

  /** Pre-migration-0065 rows say so, exactly once, rather than reading as zero. */
  it('names an uncounted pre-migration cycle rather than drawing it as no exclusions', () => {
    const row = makeArmComparison();
    row.live = { ...row.live, cost_basis_drops: null };
    row.control = { ...row.control, cost_basis_drops: null };
    renderReview(makeSnapshot({ arm_comparison: [row] }));
    const arms = screen.getByRole('region', { name: 'Arm comparison' });

    expect(
      within(arms).getAllByText(/cost-basis exclusion not counted for this cycle/),
    ).toHaveLength(1);
    expect(within(arms).queryByText(/Dropped before these counts/)).toBeNull();
  });

  it('names an unmeasured benchmark rather than drawing it as zero', () => {
    renderReview(makeSnapshot({ outside_benchmarks: [makeOutsideBenchmark()] }));
    expect(screen.getByText(/Not measured this cycle: 60\/40/)).toBeTruthy();
  });

  it('names every missing measurement', () => {
    renderReview(makeSnapshot({ arm_comparison: [], outside_benchmarks: [], analysts: [] }));
    expect(screen.getByText(/has not computed a comparison yet/)).toBeTruthy();
    expect(screen.getByText(/has not measured an outside benchmark yet/)).toBeTruthy();
    expect(screen.getByText(/No analyst weights on this snapshot/)).toBeTruthy();
  });
});

/**
 * The three `profit_factor` states this ticket exists to keep distinct
 * (#1270): a flawless window (wins, no losses) must read as the good state
 * it is, never as the same em dash `formatFixed` renders for genuinely
 * missing data; a window with no closed trades at all keeps its current
 * finite-zero reading and must not be confused with either.
 */
describe('profit factor tile', () => {
  it('reads "no losing trades" for a flawless window, not an em dash', () => {
    renderReview(makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'no_losses' } }) }));
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    expect(within(metrics).getByText('no losing trades')).toBeTruthy();
    expect(within(metrics).queryByText('—')).toBeNull();
  });

  it('formats an ordinary ratio with formatFixed', () => {
    renderReview(
      makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'ratio', value: 2.5 } }) }),
    );
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    expect(within(metrics).getByText('2.50')).toBeTruthy();
  });

  it('reads a real, finite 0 for a window with no closed trades at all, distinct from "no losing trades"', () => {
    renderReview(
      makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'ratio', value: 0 } }) }),
    );
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    expect(within(metrics).getByText('0.00')).toBeTruthy();
    expect(within(metrics).queryByText('no losing trades')).toBeNull();
  });

  it('names an unreadable profit factor rather than silently formatting a broken value', () => {
    renderReview(makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'unreadable' } }) }));
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    expect(within(metrics).getByText('could not be read')).toBeTruthy();
  });

  // The card's "no metrics on this snapshot" empty state went with #1520: it
  // was reachable only through a null SNAPSHOT (`metrics` is required and
  // non-nullable on the wire), which is now the page-level cold start. What
  // must stay distinct is the pair below — a flawless window against an
  // unreadable figure — since both are suites that DID run.
  it('renders "no losing trades" differently from an unreadable profit factor', () => {
    const { unmount } = renderReview(
      makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'no_losses' } }) }),
    );
    expect(screen.getByText('no losing trades')).toBeTruthy();
    expect(screen.queryByText('could not be read')).toBeNull();
    unmount();

    renderReview(makeSnapshot({ metrics: makeMetrics({ profit_factor: { kind: 'unreadable' } }) }));
    expect(screen.getByText('could not be read')).toBeTruthy();
    expect(screen.queryByText('no losing trades')).toBeNull();
  });

  it('renders rather than throws on a kind the type system does not admit (review round 1, MINOR)', () => {
    // Not reachable through `toWireSnapshot` — `profitFactorOf` maps every
    // input to one of the three known kinds — but `profitFactorText`'s
    // `default` arm must not crash the whole tab if a future caller ever
    // hands it something it doesn't recognise. `main.tsx` mounts with no
    // error boundary, so a throw here is a white screen, not a bad tile.
    const bogus = { kind: 'bogus' } as unknown as ReturnType<typeof makeMetrics>['profit_factor'];
    expect(() =>
      renderReview(makeSnapshot({ metrics: makeMetrics({ profit_factor: bogus }) })),
    ).not.toThrow();
    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    expect(within(metrics).getByText(/could not be read/)).toBeTruthy();
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
    expect(within(row).getByText('long')).toBeTruthy();
    expect(within(row).queryByText(/552\.10/)).toBeNull();
    expect(within(row).queryByText(/559\.80/)).toBeNull();
  });

  it('glosses a degraded debate with its termination cause (#1396)', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [
          makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1', close_reason: 'stop' }),
        ],
        debates: [
          makeDebate({
            debate_id: 'd1',
            instrument: 'SPY',
            direction: 'bullish',
            rounds: 1,
            termination: 'latency_truncated',
            termination_cause: 'llm_failure',
          }),
        ],
      }),
    );
    const row = screen.getByRole('button', { name: /SPY/ });
    expect(within(row).getByText(/degraded — an LLM call failed outright/)).toBeTruthy();
    // Same `data-degraded` hook `TraceSections.tsx`'s `DebateSection` sets —
    // both renderers of the shared gloss must expose it in the DOM, not just
    // in this row's joined text (docs/coding-standards.md's #1080 entry).
    expect(row.querySelector('[data-degraded="true"]')).toBeTruthy();
  });

  it('does not gloss a converged debate (#1396)', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [
          makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1', close_reason: 'stop' }),
        ],
        debates: [
          makeDebate({
            debate_id: 'd1',
            instrument: 'SPY',
            direction: 'bullish',
            termination: 'converged',
          }),
        ],
      }),
    );
    const row = screen.getByRole('button', { name: /SPY/ });
    expect(within(row).queryByText(/degraded/)).toBeNull();
    expect(row.querySelector('[data-degraded]')).toBeNull();
  });

  it('heads every column, naming the side rather than the entry price', () => {
    const { container } = renderReview(
      makeSnapshot({
        closed_trades: [makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1' })],
        debates: [makeDebate({ debate_id: 'd1' })],
      }),
    );
    const labels = Array.from(container.querySelectorAll('.trade-header .label')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual([
      'Closed',
      'Instrument',
      'Side',
      'Held',
      'Reason',
      'Why it was taken',
      'P&L',
    ]);
  });

  it('opens a trade’s drawer with its debate, Risk row, P&L breakdown and fills', () => {
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
        ],
      }),
    );
    const drawer = screen.getByRole('complementary', { name: 'Trade detail' });
    expect(within(drawer).getByText(/No trade selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^SPY, long/ }));
    expect(within(drawer).getByText('measured reclaim')).toBeTruthy();
    expect(within(drawer).getByRole('img', { name: 'go' })).toBeTruthy();
    expect(within(drawer).getByText(/approved · /)).toBeTruthy();
    expect(within(drawer).getByText('+$11.20')).toBeTruthy();
    expect(within(drawer).getByText('−$2.41')).toBeTruthy();
    expect(within(drawer).getAllByText('+$8.79').length).toBeGreaterThan(0);
    const pnl = drawer.querySelector('[data-section="pnl"]') as HTMLElement;
    expect(within(pnl).getByText('552.10')).toBeTruthy();
    expect(within(pnl).getByText('559.80')).toBeTruthy();
    expect(within(pnl).getByText('$11,042.00')).toBeTruthy();
    const fills = within(drawer).getByRole('list', { name: 'Fills' });
    expect(within(fills).getByText(/f-entry/)).toBeTruthy();
    expect(within(fills).getByText(/f-target/)).toBeTruthy();
    expect(within(drawer).getByText(/aged out of the 15-minute pipeline window/)).toBeTruthy();
    expect(within(drawer).queryByText(/not keyed to this trace/)).toBeNull();
  });

  it('names the missing stage record and Risk row when no trace reaches the trade', () => {
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
    expect(within(drawer).getByText(/No Risk decision keyed to this trade/)).toBeTruthy();
    expect(
      within(drawer).getByText(/debate not in the recent-debates window|No completed debate/),
    ).toBeTruthy();
  });

  it('names a flat-by-close exit "flattened"', () => {
    renderReview(
      makeSnapshot({
        closed_trades: [makeClosedTrade({ close_reason: 'flatten', realized_pnl_net: 1 })],
      }),
    );
    expect(screen.getByRole('button', { name: 'SPY, long, flattened, +$1.00' })).toBeTruthy();
  });

  it('names an empty history', () => {
    renderReview(makeSnapshot({ closed_trades: [] }));
    expect(screen.getByText(/No closed trade in the recent-history window/)).toBeTruthy();
  });
});
