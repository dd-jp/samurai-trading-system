// @vitest-environment jsdom
import type { DecisionWire, PositionWire, V2OverviewWire } from '@contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOSS_BUDGET, overview, POSITIONS } from '../../test-wire.ts';
import { GlanceView } from './GlanceView.tsx';

const AAPL = POSITIONS.positions[0] as PositionWire;

function show(changes: Partial<V2OverviewWire> = {}) {
  render(<GlanceView overview={overview(changes)} />);
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function withPositions(positions: readonly PositionWire[]): Partial<V2OverviewWire> {
  return { positions: { status: 'fed', ...POSITIONS, positions } };
}

function freshAt(price_gbp: number, unrealised_gbp: number): PositionWire['mark'] {
  return { ...(AAPL.mark as object), price_gbp, unrealised_gbp } as PositionWire['mark'];
}

const STALE_MARK: PositionWire['mark'] = { status: 'stale', bar_date: '2026-09-30' };

function decision(changes: Partial<DecisionWire>): DecisionWire {
  return {
    book_id: 'debate/primary',
    trading_date: '2026-10-05',
    instrument: 'AAPL',
    venue: 'alpaca',
    direction: 'long',
    action: 'enter_long',
    vetoed: false,
    reason: 'because',
    confidence: 0.6,
    ...changes,
  };
}

describe('GlanceView', () => {
  it('keeps the loss budget and positions panels beneath the summary', () => {
    show();
    expect(screen.getAllByRole('region').map((panel) => panel.getAttribute('aria-label'))).toEqual([
      'P&L',
      'Open risk',
      'Verdicts',
      'Loss budget',
      'Positions and cash',
    ]);
  });

  it('shows the signed cycle P&L, the unrealised sum and the open count of primary books', () => {
    const shadow: PositionWire = {
      ...AAPL,
      book_id: 'debate/no-veto',
      variant: 'no-veto',
      mark: freshAt(170, 60),
    };
    show({
      ...withPositions([AAPL, shadow]),
      loss_budget: { status: 'fed', ...LOSS_BUDGET, day_loss_gbp: 12.5 },
    });
    const panel = region('P&L');
    expect(panel.querySelector('.big')?.textContent).toBe('−£12.50');
    expect(panel.querySelector<HTMLElement>('.big')?.dataset.sign).toBe('loss');
    expect(panel.textContent).toContain(`cycle ${LOSS_BUDGET.trading_date}`);
    expect(panel.textContent).toContain('Unrealised£30.00');
    expect(panel.textContent).toContain('Open positions1');
  });

  it('shows a gain as a gain', () => {
    show({ loss_budget: { status: 'fed', ...LOSS_BUDGET, day_loss_gbp: -7 } });
    const big = region('P&L').querySelector<HTMLElement>('.big');
    expect(big?.textContent).toBe('£7.00');
    expect(big?.dataset.sign).toBe('gain');
  });

  it('counts positions with no fresh mark instead of pricing them at zero', () => {
    show(withPositions([{ ...AAPL, mark: STALE_MARK }]));
    expect(region('P&L').textContent).toContain('£0.00 (1 without a fresh mark)');
  });

  it('says so when the P&L has no cycle, or the positions are not fed', () => {
    show({
      loss_budget: { status: 'empty' },
      positions: { status: 'not-yet-fed', owner: 'x', ticket: '#1' },
    });
    expect(region('P&L').textContent).toContain('No cycle has run yet.');
    expect(region('Open risk').textContent).toContain('Not yet fed');
  });

  it('shows distance to stop and how much of the entry-to-stop risk is used', () => {
    show(withPositions([{ ...AAPL, mark: freshAt(145, -15) }]));
    const line = region('Open risk').querySelector<HTMLElement>('.risk-line');
    expect(line?.textContent).toBe('AAPL−£15.00' + '3.4% to stop');
    expect(line?.querySelector<HTMLElement>('.rail-track div')?.style.width).toBe('50%');
    expect(line?.dataset.warn).toBe('false');
  });

  it('measures a short the same way, with its stop above entry', () => {
    show(withPositions([{ ...AAPL, stop_gbp: 160, mark: freshAt(155, -15) }]));
    const line = region('Open risk').querySelector<HTMLElement>('.risk-line');
    expect(line?.textContent).toContain('3.2% to stop');
    expect(line?.querySelector<HTMLElement>('.rail-track div')?.style.width).toBe('50%');
  });

  it('draws no risk used while in profit, and caps it once through the stop', () => {
    show(
      withPositions([
        { ...AAPL, mark: freshAt(160, 30) },
        { ...AAPL, instrument: 'MSFT', mark: freshAt(130, -60) },
      ]),
    );
    const widths = [...region('Open risk').querySelectorAll<HTMLElement>('.rail-track div')].map(
      (fill) => fill.style.width,
    );
    expect(widths).toEqual(['0%', '100%']);
  });

  it('flags a position with no stop or no fresh mark and draws no track', () => {
    show(
      withPositions([
        { ...AAPL, stop_gbp: null },
        { ...AAPL, instrument: 'MSFT', mark: STALE_MARK },
      ]),
    );
    const lines = [...region('Open risk').querySelectorAll<HTMLElement>('.risk-line')];
    expect(lines[0]?.textContent).toContain('no stop');
    expect(lines[1]?.textContent).toContain('no fresh mark');
    expect(lines.map((line) => line.dataset.warn)).toEqual(['true', 'true']);
    expect(region('Open risk').querySelector('.rail-track')).toBeNull();
  });

  it('leaves shadow positions out of the open risk', () => {
    show(withPositions([{ ...AAPL, variant: 'no-veto' }]));
    expect(region('Open risk').textContent).toContain('No open positions.');
  });

  it.each([
    [{ action: 'enter_long' }, '可', 'go', 'entered long'],
    [{ action: 'enter_short' }, '可', 'go', 'entered short'],
    [{ action: 'enter_long', vetoed: true }, '否', 'nogo', 'vetoed'],
    [{ action: 'exit' }, '止', 'stop', 'exited'],
    [{ action: 'skip' }, '略', 'skip', 'skipped'],
    [{ action: 'none' }, '略', 'skip', 'none'],
  ] as const)('seals %o', (change, kanji, kind, outcome) => {
    show({
      decisions: {
        status: 'fed',
        trading_date: '2026-10-05',
        decisions: [decision(change)],
      },
    });
    const row = within(region('Verdicts')).getByRole('listitem');
    const seal = row.querySelector<HTMLElement>('.seal');
    expect(seal?.textContent).toBe(kanji);
    expect(seal?.dataset.seal).toBe(kind);
    expect(row.textContent).toContain(`${outcome}: because`);
    expect(row.textContent).toContain('60%');
  });
});
