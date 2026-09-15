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
import { doneThrough, makeView } from '../../lib/test-support.ts';
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
    expect(within(drawer).getByText(/bound by risk_critic:invalidated/)).toBeTruthy();
    expect(within(drawer).queryByText(/critic reject/)).toBeNull();
  });

  it('shows the lane list with no debate cell decorated from the live arm’s debate log', () => {
    renderLive(
      makeSnapshot({
        arm: 'control',
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        debates: [makeDebate({ debate_id: 'd1', instrument: 'SPY' })],
      }),
      null,
    );
    expect(screen.getByRole('button', { name: /SPY/ })).toBeTruthy();
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
