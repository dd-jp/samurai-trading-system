// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOSS_BUDGET } from '../../test-wire.ts';
import { LossBudgetPanel } from './LossBudgetPanel.tsx';

function region() {
  return screen.getByRole('region', { name: 'Loss budget' });
}

describe('LossBudgetPanel (P1)', () => {
  it('draws the marks from the configured cap, never a literal (D8)', () => {
    render(
      <LossBudgetPanel
        panel={{
          status: 'fed',
          ...LOSS_BUDGET,
          loss_cap_gbp: 3_000,
          step_marks_gbp: [1_000, 2_000, 3_000],
          daily_cap_gbp: 40,
        }}
      />,
    );
    const marks = within(region()).getByRole('list', { name: 'Size steps' });
    expect(marks.textContent).toBe('−£1,000.00: ½ size−£2,000.00: ¼ size−£3,000.00: halt');
    expect(region().textContent).not.toContain('£1,500');
    expect(
      screen.getByRole('img', { name: /Year-to-date loss.*−£120\.00 against −£3,000\.00/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /Today's loss.*−£5\.00 against −£40\.00/ }),
    ).toBeTruthy();
  });

  it('lists each primary book with its shadows under it, with size step and entry block', () => {
    render(<LossBudgetPanel panel={{ status: 'fed', ...LOSS_BUDGET }} />);
    const rows = within(region()).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'debate/primary−£120.00−£5.001open',
      '↳ no-veto (shadow)−£300.00£2.00½blocked at next fill',
    ]);
  });

  it('flags a stale capital config and a reached cap', () => {
    render(
      <LossBudgetPanel
        panel={{ status: 'fed', ...LOSS_BUDGET, capital_stale: true, day_loss_gbp: 20 }}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain("marks use 2026's");
    expect(region().textContent).toContain('−£20.00 of −£20.00 (reached)');
  });

  it('does not call a zero daily cap reached before any loss', () => {
    render(
      <LossBudgetPanel
        panel={{ status: 'fed', ...LOSS_BUDGET, daily_cap_gbp: 0, day_loss_gbp: 0 }}
      />,
    );
    expect(region().textContent).not.toContain('(reached)');
  });

  it('says no cycle has run when empty', () => {
    render(<LossBudgetPanel panel={{ status: 'empty' }} />);
    expect(region().textContent).toContain('No cycle has run yet.');
  });

  it('names the owner and ticket when not yet fed', () => {
    render(
      <LossBudgetPanel
        panel={{ status: 'not-yet-fed', owner: 'npm run v2:capital (D8)', ticket: '#1745' }}
      />,
    );
    expect(region().textContent).toContain('Not yet fed: npm run v2:capital (D8) (#1745).');
  });
});
