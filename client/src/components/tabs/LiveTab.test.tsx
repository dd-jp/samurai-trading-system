// @vitest-environment jsdom
/**
 * #1597: the control arm trades by indicator alone (no LLM debate) and
 * consults no critic (no model to consult) — the trace drawer names both
 * absences instead of rendering nothing, or the live arm's own debate for a
 * lane trading the same instrument. No test file existed for `LiveTab.tsx`
 * before this ticket.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Selection } from '../../lib/resolve-trace.ts';
import { at, doneThrough, makeLane, makeView } from '../../lib/test-support.ts';
import { makeDebate, makeRiskCritic, makeSnapshot } from '../../test-fixtures.ts';
import { LiveTab } from './LiveTab.tsx';

function renderLive(snapshot: ReturnType<typeof makeSnapshot>, selection: Selection | null) {
  return render(<LiveTab snapshot={snapshot} selection={selection} onSelect={() => {}} />);
}

describe('LiveTab — control arm', () => {
  it('names the debate absence in the trace drawer instead of the live arm’s debate for the same instrument', () => {
    renderLive(
      makeSnapshot({
        arm: 'control',
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'risk', { outcome: 'stopped' })]),
        // Same instrument as the lane — proves the join is skipped by arm,
        // not merely absent from this fixture.
        debates: [makeDebate({ debate_id: 'd1', instrument: 'SPY', direction: 'bullish' })],
        risk_critics: [
          makeRiskCritic({
            trace_id: 'trace-spy',
            instrument: 'SPY',
            binding_constraint: null,
            critic_verdict: null,
          }),
        ],
      }),
      { instrument: 'SPY', traceId: null },
    );
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(within(drawer).getByText('Control arm: no LLM debate — not applicable')).toBeTruthy();
    expect(within(drawer).queryByText(/bullish · \d+ rounds/)).toBeNull();
  });

  it('names the critic-verdict absence while the control’s own Risk decision still renders', () => {
    renderLive(
      makeSnapshot({
        arm: 'control',
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'risk', { outcome: 'stopped' })]),
        debates: [],
        risk_critics: [
          makeRiskCritic({
            trace_id: 'trace-spy',
            instrument: 'SPY',
            binding_constraint: 'risk_critic:invalidated',
            critic_verdict: 'reject',
          }),
        ],
      }),
      { instrument: 'SPY', traceId: null },
    );
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(within(drawer).getByText('Control arm: no LLM critic — not applicable')).toBeTruthy();
    expect(
      within(drawer).getByText(/risk_critic:invalidated — measured breach of a condition below/),
    ).toBeTruthy();
    expect(within(drawer).queryByText(/critic reject/)).toBeNull();
  });

  /**
   * #1597 review round 1: the prior version of this test only asserted a
   * lane button exists, which passed identically whether or not `LaneList`'s
   * arm guard on `laneDebate` actually ran — reverting the guard left the
   * suite green. A degraded `debate` cell is the one place the joined row is
   * OBSERVABLE on the matrix (`lane-cells.ts`'s `degradedText` appends the
   * debate's own termination cause to a `budget_exhausted`/`timed_out_partial`
   * decision's title), so this fixture gives the live arm's row a recorded
   * cause the control lane must not inherit.
   */
  it('carries no debate decoration on the lane matrix, even when a live debate for the same instrument is degraded', () => {
    renderLive(
      makeSnapshot({
        arm: 'control',
        pipeline: makeView([
          makeLane({
            instrument: 'SPY',
            trace_id: 'trace-spy',
            outcome: 'stopped',
            final_stage: 'debate',
            cells: { debate: { state: 'done', decision: 'budget_exhausted', recorded_at: at(0) } },
          }),
        ]),
        // Same instrument as the lane, with a recorded termination cause —
        // proves the matrix reads no cause from the live arm's row, not
        // merely that this fixture has none to read.
        debates: [
          makeDebate({
            debate_id: 'd1',
            instrument: 'SPY',
            termination: 'latency_truncated',
            termination_cause: 'budget',
          }),
        ],
      }),
      null,
    );
    const decision = screen.getByText(/budget_exhausted/);
    expect(decision.title).not.toContain('latency budget exceeded');
  });
});

describe('LiveTab — live arm', () => {
  it('renders no control-arm N/A sentence anywhere on the tab', () => {
    renderLive(
      makeSnapshot({
        arm: 'live',
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'risk', { outcome: 'stopped' })]),
        debates: [makeDebate({ debate_id: 'd1', instrument: 'SPY', direction: 'bullish' })],
        risk_critics: [
          makeRiskCritic({ trace_id: 'trace-spy', instrument: 'SPY', critic_verdict: 'pass' }),
        ],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(screen.queryByText('Control arm: no LLM debate — not applicable')).toBeNull();
    expect(screen.queryByText('Control arm: no LLM critic — not applicable')).toBeNull();
    expect(screen.queryByText('Control arm: tick status is not persisted')).toBeNull();
  });
});
