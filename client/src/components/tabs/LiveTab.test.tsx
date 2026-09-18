// @vitest-environment jsdom
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
