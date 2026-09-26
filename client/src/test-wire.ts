import {
  type ControlWire,
  type LossBudgetWire,
  type PositionsWire,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '@contracts';

export const LOSS_BUDGET: LossBudgetWire = {
  year: 2026,
  capital_stale: false,
  trading_date: '2026-10-05',
  start_capital_gbp: 2_000,
  loss_cap_gbp: 1_500,
  step_marks_gbp: [500, 1_000, 1_500],
  daily_cap_gbp: 20,
  ytd_loss_gbp: 120,
  day_loss_gbp: 5,
  books: [
    {
      book_id: 'debate/primary',
      sleeve_id: 'debate',
      variant: 'primary',
      trading_date: '2026-10-05',
      ytd_loss_gbp: 120,
      day_loss_gbp: 5,
      size_multiplier: 1,
      entries_blocked: false,
    },
    {
      book_id: 'debate/no-veto',
      sleeve_id: 'debate',
      variant: 'no-veto',
      trading_date: '2026-10-05',
      ytd_loss_gbp: 300,
      day_loss_gbp: -2,
      size_multiplier: 0.5,
      entries_blocked: true,
    },
  ],
};

export const POSITIONS: PositionsWire = {
  as_of: '2026-10-05',
  fx: { gbp_usd: 1.25, year: 2026, source: 'BoE XUDLUSS' },
  positions: [
    {
      book_id: 'debate/primary',
      variant: 'primary',
      instrument: 'AAPL',
      venue: 'alpaca',
      currency: 'USD',
      qty: 3,
      entry_gbp: 150,
      stop_gbp: 140,
      opened_date: '2026-10-01',
      marks_held: 3,
      mark: {
        status: 'fresh',
        bar_date: '2026-10-02',
        price_quote: 200,
        price_gbp: 160,
        market_value_gbp: 480,
        unrealised_gbp: 30,
      },
    },
  ],
  cash: [{ book_id: 'debate/primary', variant: 'primary', cash_gbp: 520 }],
  venues: [
    { venue: 'alpaca', currency: 'USD', positions_value_quote: 600, positions_value_gbp: 480 },
    { venue: 'saxo', currency: 'GBP', positions_value_quote: 0, positions_value_gbp: 0 },
  ],
  total_gbp: 1_000,
};

export const CONTROL: ControlWire = {
  state: 'running',
  in_force: null,
  loss_budget_halted_books: [],
  history: [],
};

export function overview(overrides: Partial<V2OverviewWire> = {}): V2OverviewWire {
  return {
    contract_version: V2_CONTRACT_VERSION,
    generated_at: '2026-10-06T21:40:00.000Z',
    mode: 'paper',
    loss_budget: { status: 'fed', ...LOSS_BUDGET },
    control: CONTROL,
    positions: { status: 'fed', ...POSITIONS },
    decisions: {
      status: 'fed',
      trading_date: '2026-10-05',
      decisions: [
        {
          book_id: 'debate/primary',
          trading_date: '2026-10-05',
          instrument: 'AAPL',
          venue: 'alpaca',
          direction: 'long',
          action: 'enter_long',
          vetoed: false,
          reason: 'debate consensus',
          confidence: 0.71,
        },
      ],
    },
    llm_spend: {
      status: 'fed',
      month_start: '2026-10-01T00:00:00.000Z',
      spent_usd: 4.2,
      budget_usd: 30,
      calls_stopped: false,
      by_model: [],
      by_day: [],
    },
    heartbeat: {
      last_cycle: {
        status: 'fed',
        trading_date: '2026-10-05',
        recorded_at: '2026-10-05T21:40:00.000Z',
      },
      next_due: { status: 'not-yet-fed', owner: 'Step 3e', ticket: '#1784' },
      last_ping: { status: 'not-yet-fed', owner: 'Step 3e', ticket: '#1784' },
    },
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
