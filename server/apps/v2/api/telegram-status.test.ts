import { describe, expect, it } from 'vitest';
import {
  type PositionWire,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import { formatStatus } from './telegram-status.js';

const NOT_FED = { status: 'not-yet-fed', owner: 'x', ticket: '#1' } as const;

function position(instrument: string, unrealised: number | 'stale'): PositionWire {
  return {
    book_id: 'debate/primary',
    variant: 'primary',
    instrument,
    venue: 'alpaca',
    currency: 'USD',
    qty: 3,
    entry_gbp: 100,
    stop_gbp: 90,
    opened_date: '2026-09-25',
    marks_held: 2,
    mark:
      unrealised === 'stale'
        ? { status: 'stale', bar_date: '2026-09-24' }
        : {
            status: 'fresh',
            bar_date: '2026-09-28',
            price_quote: 130,
            price_gbp: 104,
            market_value_gbp: 312,
            unrealised_gbp: unrealised,
          },
  };
}

function overview(patch: Partial<V2OverviewWire> = {}): V2OverviewWire {
  return {
    contract_version: V2_CONTRACT_VERSION,
    generated_at: '2026-09-29T10:00:00.000Z',
    mode: 'paper',
    loss_budget: {
      status: 'fed',
      year: 2026,
      capital_stale: false,
      trading_date: '2026-09-28',
      start_capital_gbp: 2_000,
      loss_cap_gbp: 1_500,
      step_marks_gbp: [500, 1_000, 1_500],
      daily_cap_gbp: 20,
      ytd_loss_gbp: 1_234.5,
      day_loss_gbp: -3,
      books: [],
    },
    control: { state: 'running', in_force: null, loss_budget_halted_books: [], history: [] },
    positions: {
      status: 'fed',
      as_of: '2026-09-28',
      fx: null,
      positions: [position('MSFT', 12.5), position('AAPL', -1234.5)],
      cash: [
        { book_id: 'debate/primary', variant: 'primary', cash_gbp: 1_000 },
        { book_id: 'debate/no-macro-gate', variant: 'no-macro-gate', cash_gbp: 500.25 },
      ],
      venues: [],
      total_gbp: 700,
    },
    decisions: { status: 'empty' },
    llm_spend: {
      status: 'fed',
      month_start: '2026-09-01T00:00:00.000Z',
      spent_usd: 4.2,
      budget_usd: 30,
      calls_stopped: false,
      by_model: [],
      by_day: [],
    },
    heartbeat: {
      last_cycle: {
        status: 'fed',
        trading_date: '2026-09-28',
        recorded_at: '2026-09-28T21:40:00.000Z',
      },
      next_due: NOT_FED,
      last_ping: NOT_FED,
    },
    ...patch,
  };
}

describe('formatStatus', () => {
  it('reports every part of a fully fed store', () => {
    expect(formatStatus(overview())).toBe(
      [
        'Samurai v2 status (paper)',
        'State: RUNNING',
        'Equity: £2,200.25 (cash £1,500.25, positions £700.00)',
        'Open positions: 2',
        '  MSFT x3 [debate/primary] £12.50',
        '  AAPL x3 [debate/primary] -£1,234.50',
        'Loss budget 2026: year-to-date loss £1,234.50 of £1,500.00 cap; today -£3.00 of £20.00 daily cap',
        'LLM spend this month: $4.20 of $30.00',
        'Last cycle: 2026-09-28',
      ].join('\n'),
    );
  });

  it('labels the mode', () => {
    expect(formatStatus(overview({ mode: 'dry-run' })).split('\n')[0]).toBe(
      'Samurai v2 status (dry-run)',
    );
  });

  it.each([
    ['paused', 'PAUSED (entries blocked)'],
    [
      'halted-manual',
      'HALTED (manual, closing every position within about a minute, or at the next cycle if the signals process is down)',
    ],
    ['halted-loss-budget', 'HALTED (loss budget)'],
  ] as const)('names the %s state', (state, label) => {
    const line = formatStatus(
      overview({ control: { state, in_force: null, loss_budget_halted_books: [], history: [] } }),
    ).split('\n')[1];
    expect(line).toBe(`State: ${label}`);
  });

  it('says when and why a manual control was set, and which books the loss budget halted', () => {
    const inForce = {
      control_id: 4,
      action: 'pause',
      reason: 'news risk',
      source: 'telegram',
      set_at: '2026-09-29T09:00:00.000Z',
    } as const;
    const line = formatStatus(
      overview({
        control: {
          state: 'paused',
          in_force: inForce,
          loss_budget_halted_books: ['debate/primary', 'debate/no-macro-gate'],
          history: [inForce],
        },
      }),
    ).split('\n')[1];
    expect(line).toBe(
      'State: PAUSED (entries blocked) since 2026-09-29T09:00:00.000Z: news risk; loss-budget halt on debate/primary, debate/no-macro-gate',
    );
  });

  it('shows n/a for every panel that is not fed', () => {
    expect(
      formatStatus(
        overview({
          loss_budget: NOT_FED,
          positions: { status: 'empty' },
          llm_spend: NOT_FED,
          heartbeat: { last_cycle: { status: 'empty' }, next_due: NOT_FED, last_ping: NOT_FED },
        }),
      ),
    ).toBe(
      [
        'Samurai v2 status (paper)',
        'State: RUNNING',
        'Equity: n/a',
        'Open positions: n/a',
        'Loss budget: n/a',
        'LLM spend: n/a',
        'Last cycle: n/a',
      ].join('\n'),
    );
  });

  it('says none for an empty book and n/a when the spend total is unknown', () => {
    const lines = formatStatus(
      overview({
        positions: {
          status: 'fed',
          as_of: '2026-09-28',
          fx: null,
          positions: [],
          cash: [{ book_id: 'debate/primary', variant: 'primary', cash_gbp: 1_000 }],
          venues: [],
          total_gbp: 0,
        },
        llm_spend: {
          status: 'fed',
          month_start: '2026-09-01T00:00:00.000Z',
          spent_usd: null,
          budget_usd: 30,
          calls_stopped: true,
          by_model: [],
          by_day: [],
        },
      }),
    ).split('\n');
    expect(lines).toContain('Open positions: none');
    expect(lines).toContain('Equity: £1,000.00 (cash £1,000.00, positions £0.00)');
    expect(lines).toContain('LLM spend this month: n/a of $30.00 (calls stopped)');
  });

  it('flags stale marks instead of inventing an equity', () => {
    const lines = formatStatus(
      overview({
        positions: {
          status: 'fed',
          as_of: '2026-09-28',
          fx: null,
          positions: [position('MSFT', 'stale')],
          cash: [{ book_id: 'debate/primary', variant: 'primary', cash_gbp: 1_000 }],
          venues: [],
          total_gbp: null,
        },
      }),
    ).split('\n');
    expect(lines).toContain('Equity: n/a (cash £1,000.00, marks stale)');
    expect(lines).toContain('  MSFT x3 [debate/primary] mark stale');
  });

  it('lists ten positions and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, index) => position(`S${index}`, 1));
    const lines = formatStatus(
      overview({
        positions: {
          status: 'fed',
          as_of: '2026-09-28',
          fx: null,
          positions: many,
          cash: [],
          venues: [],
          total_gbp: 0,
        },
      }),
    ).split('\n');
    expect(lines).toContain('Open positions: 12');
    expect(lines.filter((line) => line.startsWith('  S'))).toHaveLength(10);
    expect(lines).toContain('  and 2 more');
  });
});
