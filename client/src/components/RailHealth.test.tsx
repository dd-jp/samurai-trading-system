// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOSS_BUDGET, overview } from '../test-wire.ts';
import { RailHealth } from './RailHealth.tsx';

const SPEND = {
  status: 'fed',
  month_start: '2026-10-01T00:00:00.000Z',
  spent_usd: 4.2,
  budget_usd: 30,
  calls_stopped: false,
  by_model: [],
  by_day: [],
} as const;

function gauge(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

function fill(element: HTMLElement): string | undefined {
  return element.querySelector<HTMLElement>('.rail-track div')?.style.width;
}

describe('RailHealth', () => {
  it('shows the year loss and the LLM spend against their caps', () => {
    render(<RailHealth overview={overview()} />);
    expect(gauge('Loss budget').textContent).toContain('−£120.00 of −£1,500.00');
    expect(fill(gauge('Loss budget'))).toBe('8%');
    expect(gauge('Loss budget').dataset.alarm).toBe('false');
    expect(gauge('LLM cap').textContent).toContain('$4.20 of $30.00');
    expect(gauge('LLM cap').dataset.alarm).toBe('false');
  });

  it('alarms and clamps the fill once the loss cap is passed', () => {
    render(
      <RailHealth
        overview={overview({
          loss_budget: { status: 'fed', ...LOSS_BUDGET, ytd_loss_gbp: 1_600 },
        })}
      />,
    );
    expect(gauge('Loss budget').dataset.alarm).toBe('true');
    expect(fill(gauge('Loss budget'))).toBe('100%');
  });

  it('does not alarm one penny short of the loss cap', () => {
    render(
      <RailHealth
        overview={overview({
          loss_budget: { status: 'fed', ...LOSS_BUDGET, ytd_loss_gbp: 1_499.99 },
        })}
      />,
    );
    expect(gauge('Loss budget').dataset.alarm).toBe('false');
  });

  it.each([
    ['unreadable', { spent_usd: null, calls_stopped: false }],
    ['stopped', { spent_usd: 30, calls_stopped: true }],
  ])('alarms when the LLM spend is %s', (_name, change) => {
    render(<RailHealth overview={overview({ llm_spend: { ...SPEND, ...change } })} />);
    expect(gauge('LLM cap').dataset.alarm).toBe('true');
  });

  it('says so when a gauge is empty or not fed, and draws no track', () => {
    render(
      <RailHealth
        overview={overview({
          loss_budget: { status: 'empty' },
          llm_spend: { status: 'not-yet-fed', owner: 'Step 3e', ticket: '#9' },
        })}
      />,
    );
    expect(gauge('Loss budget').textContent).toContain('none yet');
    expect(gauge('LLM cap').textContent).toContain('not yet fed (#9)');
    expect(fill(gauge('LLM cap'))).toBeUndefined();
  });
});
