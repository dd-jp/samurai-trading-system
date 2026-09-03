// @vitest-environment jsdom
//
// #1066: the drawer's invalidation section, deferred out of #994's fold of the
// typed invalidation-condition mechanism into the Risk Critic.
//
// The properties under test are the ones an operator reads the section FOR:
// every measured condition is shown with the fact measured about it, a
// `risk_critic:invalidated` rejection (a measured breach) is visibly not a
// `risk_critic:reject` (the critic's prose), a validator drop is visible even
// when nothing survived to be evaluated, and a row written before the fold
// renders as "no conditions" rather than throwing.

import type { RiskCriticRow } from '@contracts';
import { render, within } from '@testing-library/react';
// Explicit, like the panel suites: `vitest/globals` is on the root
// `tsconfig.test.json` only, so these names are unresolvable in a `client/`
// test without this import under `yarn typecheck`.
import { describe, expect, it } from 'vitest';
import { makeLane } from '../lib/test-support.ts';
import { makeCondition, makeRiskCritic } from '../test-fixtures.ts';
import { DetailDrawer } from './DetailDrawer.tsx';

const LANE = makeLane({
  instrument: 'ETH-USD',
  trace_id: 'trace-eth',
  outcome: 'stopped',
  final_stage: 'risk',
  cells: { risk: { state: 'done', recorded_at: '2026-08-07T11:58:00.000Z' } },
});

/**
 * Scoped to the render's OWN container rather than the document: one test
 * below renders the drawer twice to compare two binding constraints, and a
 * document-wide query would find both sections.
 */
function renderDrawer(riskCritic: RiskCriticRow | undefined) {
  const { container } = render(
    <DetailDrawer
      instrument="ETH-USD"
      traceId="trace-eth"
      lane={LANE}
      debate={undefined}
      verdict={undefined}
      riskCritic={riskCritic}
    />,
  );
  return within(container).getByRole('region', { name: 'Instrument detail' });
}

/**
 * Queried through the semantic `data-*` attributes the section renders — the
 * same convention the stage strip and the state chips already use — rather
 * than test-only hooks in the shipped markup.
 */
function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no element matching ${selector}`);
  return found;
}

function queryCondition(drawer: HTMLElement, id: string): HTMLElement {
  return requireElement(drawer, `[data-condition="${id}"]`);
}

function bindingLine(drawer: HTMLElement): HTMLElement {
  return requireElement(drawer, '[data-invalidation="binding"]');
}

describe('DetailDrawer invalidation section', () => {
  it('renders each condition with its observable, predicate, observed value and state', () => {
    const drawer = renderDrawer(
      makeRiskCritic({
        conditions: [
          makeCondition({
            id: 'mark-breaks-entry',
            observable: 'mark',
            comparator: '<',
            threshold: 3200,
            state: 'breached',
            observed: 3180.5,
          }),
          makeCondition({
            id: 'rsi-rolls-over',
            observable: 'indicator:rsi@5m',
            comparator: '<',
            threshold: 45,
            state: 'not_breached',
            observed: 58.2,
          }),
          makeCondition({
            id: 'volume-thins',
            observable: 'bars:volume_ratio@5m',
            comparator: '<',
            threshold: 0.8,
            state: 'unevaluable',
            observed: null,
          }),
        ],
      }),
    );

    const breached = queryCondition(drawer, 'mark-breaks-entry');
    expect(within(breached).getByText('mark')).toBeTruthy();
    expect(within(breached).getByText('< 3200')).toBeTruthy();
    expect(within(breached).getByText('3180.5')).toBeTruthy();
    expect(within(breached).getByText('breached')).toBeTruthy();
    expect(breached.getAttribute('data-condition-state')).toBe('breached');

    const held = queryCondition(drawer, 'rsi-rolls-over');
    expect(within(held).getByText('indicator:rsi@5m')).toBeTruthy();
    expect(within(held).getByText('not breached')).toBeTruthy();
    expect(held.getAttribute('data-condition-state')).toBe('not_breached');

    // `observed` is null exactly when the read failed, and a `0` there would be
    // a measurement that never happened.
    const unread = queryCondition(drawer, 'volume-thins');
    expect(within(unread).getByText('not read')).toBeTruthy();
    expect(within(unread).queryByText('0')).toBeNull();
    expect(unread.getAttribute('data-condition-state')).toBe('unevaluable');
  });

  it('shows a risk_critic:invalidated rejection as a different fact from risk_critic:reject', () => {
    const invalidated = renderDrawer(
      makeRiskCritic({ binding_constraint: 'risk_critic:invalidated', critic_verdict: 'pass' }),
    );
    const invalidatedLine = bindingLine(invalidated);
    expect(invalidatedLine.getAttribute('data-binding')).toBe('risk_critic:invalidated');
    const invalidatedText = invalidatedLine.textContent ?? '';

    const rejected = renderDrawer(
      makeRiskCritic({
        binding_constraint: 'risk_critic:reject',
        critic_verdict: 'reject',
        conditions: [makeCondition({ state: 'not_breached', observed: 3400 })],
      }),
    );
    const rejectedLine = bindingLine(rejected);
    expect(rejectedLine.getAttribute('data-binding')).toBe('risk_critic:reject');
    expect(rejectedLine.textContent).not.toBe(invalidatedText);
  });

  it('surfaces no_conditions and every drop reason together', () => {
    const drawer = renderDrawer(
      makeRiskCritic({
        conditions: [],
        dropped_conditions: [
          { id: 'rsi-over-9000', raw: '{"threshold":9000}', reason: 'threshold_out_of_range' },
          { id: null, raw: 'not an object', reason: 'unparseable' },
        ],
      }),
    );

    expect(drawer.querySelector('[data-invalidation="no-conditions"]')).toBeTruthy();
    const drops = Array.from(drawer.querySelectorAll('[data-drop-reason]'));
    expect(drops).toHaveLength(2);
    expect(within(drawer).getByText(/threshold_out_of_range/)).toBeTruthy();
    expect(within(drawer).getByText(/unparseable/)).toBeTruthy();
    expect(within(drawer).getByText(/rsi-over-9000/)).toBeTruthy();
  });

  it('renders a pre-fold row, which carries no conditions field at all, as no conditions', () => {
    const drawer = renderDrawer(
      makeRiskCritic({ conditions: null, dropped_conditions: null, critic_verdict: 'trim' }),
    );

    expect(drawer.querySelector('[data-invalidation="no-conditions"]')).toBeTruthy();
    expect(drawer.querySelectorAll('[data-drop-reason]')).toHaveLength(0);
  });

  it('names the reason when no Risk decision is on the snapshot for this trace', () => {
    const drawer = renderDrawer(undefined);

    const empty = requireElement(drawer, '[data-invalidation="no-decision"]');
    expect(empty.textContent).toMatch(/recent/i);
  });
});
