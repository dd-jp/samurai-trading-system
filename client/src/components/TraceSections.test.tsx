// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRiskCritic } from '../test-fixtures.ts';
import { GatesSection } from './TraceSections.tsx';

describe('GatesSection', () => {
  it('names a reject verdict as prose with no measured breach, distinct from an invalidated one', () => {
    render(
      <GatesSection
        riskCritic={makeRiskCritic({ binding_constraint: 'risk_critic:reject' })}
        verdict={undefined}
        keyedBy={{ by: 'debate_id', exact: true }}
        isControl={false}
      />,
    );
    expect(
      screen.getByText("risk_critic:reject — critic's prose verdict, no measured breach"),
    ).toBeTruthy();
  });

  it('names a null critic verdict as skipped rather than reading it as a verdict', () => {
    render(
      <GatesSection
        riskCritic={makeRiskCritic({ critic_verdict: null })}
        verdict={undefined}
        keyedBy={{ by: 'trace_id', exact: true }}
        isControl={false}
      />,
    );
    expect(screen.getByText('no critic verdict — skipped, or no linked debate')).toBeTruthy();
  });

  it('names an unavailable critic verdict as "could not answer" rather than a pass/reject', () => {
    render(
      <GatesSection
        riskCritic={makeRiskCritic({ critic_verdict: 'unavailable' })}
        verdict={undefined}
        keyedBy={{ by: 'trace_id', exact: true }}
        isControl={false}
      />,
    );
    expect(
      screen.getByText('critic could not answer — mechanical checks alone decided'),
    ).toBeTruthy();
  });
});
