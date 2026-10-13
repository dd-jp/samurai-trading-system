import {
  type ControlWire,
  type EvidenceWire,
  type JournalWire,
  type LossBudgetWire,
  type PositionsWire,
  type ResearchWire,
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
      loss_cap_gbp: 450,
      step_marks_gbp: [150, 300, 450],
      daily_cap_gbp: 6,
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
      loss_cap_gbp: 450,
      step_marks_gbp: [150, 300, 450],
      daily_cap_gbp: 6,
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
      next_due: { status: 'fed', due_date: '2026-10-06' },
      last_ping: { status: 'fed', outcome: 'success', pinged_at: '2026-10-05T21:41:00.000Z' },
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

const ARM2_OWNER = { status: 'not-yet-fed', owner: 'arm 2', ticket: '#1773' } as const;
const STEP_1B_OWNER = { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' } as const;

export function evidence(overrides: Partial<EvidenceWire> = {}): EvidenceWire {
  return {
    contract_version: V2_CONTRACT_VERSION,
    generated_at: '2026-10-06T21:40:00.000Z',
    performance: {
      status: 'fed',
      books: [
        {
          book_id: 'debate/no-veto',
          sleeve_id: 'debate',
          variant: 'no-veto',
          days: 3,
          sharpe: null,
          max_drawdown: 0,
          equity: [{ trading_date: '2026-10-05', equity_gbp: 1_000 }],
        },
        {
          book_id: 'debate/primary',
          sleeve_id: 'debate',
          variant: 'primary',
          days: 3,
          sharpe: 1.234,
          max_drawdown: 0.05,
          equity: [
            { trading_date: '2026-10-01', equity_gbp: 2_000 },
            { trading_date: '2026-10-02', equity_gbp: 1_900 },
            { trading_date: '2026-10-05', equity_gbp: 1_940 },
          ],
        },
      ],
    },
    vs_arm2: ARM2_OWNER,
    vs_benchmark: STEP_1B_OWNER,
    trade_count: {
      status: 'fed',
      target: 100,
      books: [
        {
          book_id: 'debate/primary',
          variant: 'primary',
          closed_trades: 12,
          by_entry_offset: [
            { entry_offset_bps: 0, closed_trades: 3 },
            { entry_offset_bps: 50, closed_trades: 12 },
          ],
          by_model_pins: [
            { pin_digest: null, closed_trades: 4 },
            { pin_digest: '0123456789abcdef', closed_trades: 11 },
          ],
        },
      ],
    },
    arm2_test: ARM2_OWNER,
    band: STEP_1B_OWNER,
    gate: { status: 'not-yet-fed', owner: 'Step 1b and Step 4', ticket: '#1785' },
    ...overrides,
  };
}

export const JOURNAL: JournalWire = {
  contract_version: V2_CONTRACT_VERSION,
  days: [
    {
      trading_date: '2026-10-05',
      decisions: [
        {
          decision_id: 'd-1',
          book_id: 'debate/primary',
          variant: 'primary',
          instrument: 'AAPL',
          venue: 'alpaca',
          direction: 'long',
          action: 'skip',
          vetoed: true,
          veto: 'earnings',
          reason: 'vetoed:earnings',
          confidence: 0.64,
          size_shares: 0,
          stop_price: null,
          inputs_hash: 'abc123',
          debate_id: 'debate-9',
          payload: { judge: 'opus' },
          recorded_at: '2026-10-05T21:40:00.000Z',
          orders: [],
        },
      ],
      unlinked_orders: [
        {
          client_order_id: 'exit-1',
          book_id: 'debate/primary',
          instrument: 'MSFT',
          venue: 'alpaca',
          leg: 'exit',
          side: 'sell',
          dry_run: false,
          outcome: 'filled',
          payload: {},
          recorded_at: '2026-10-05T21:41:00.000Z',
          fills: [
            {
              fill_id: 'f-1',
              leg: 'entry',
              qty: 2,
              price_gbp: 310,
              fee_gbp: 0.5,
              recorded_at: '2026-10-05T21:42:00.000Z',
            },
            {
              fill_id: 'f-2',
              leg: 'cash_in_lieu',
              qty: 0.5,
              price_gbp: 300,
              fee_gbp: 0,
              recorded_at: '2026-10-05T21:43:00.000Z',
            },
          ],
        },
      ],
      refusals: [
        {
          refusal_id: 7,
          scope: 'capital',
          parameter: 'CAPITAL_CONFIG',
          ticket: 'D8',
          message: 'no capital config',
          book_id: null,
          instrument: null,
          recorded_at: '2026-10-05T21:40:00.000Z',
          feature_off: null,
        },
        ...(
          [
            [8, 'parameter', 'G18_SOCIAL_SOURCE', '#1753', 'social source'],
            [9, 'parameter', 'CFD_COST_MODEL', '#1850', null],
            [10, 'universe', 'G18_SMALL_CAP_FLOORS', '#1753', 'small-cap floors'],
            [11, 'universe', 'G18_SMALL_CAP_FLOORS', '#1753', 'small-cap floors'],
          ] as const
        ).map(([refusal_id, scope, parameter, ticket, feature_off]) => ({
          refusal_id,
          scope,
          parameter,
          ticket,
          message: `${parameter} is not set`,
          book_id: null,
          instrument: null,
          recorded_at: '2026-10-05T21:40:00.000Z',
          feature_off,
        })),
      ],
    },
  ],
  next_before: '2026-10-05',
};

export function research(overrides: Partial<ResearchWire> = {}): ResearchWire {
  const loop = { status: 'not-yet-fed', owner: 'G11 not ruled', ticket: '#1717' } as const;
  return {
    contract_version: V2_CONTRACT_VERSION,
    generated_at: '2026-10-06T21:40:00.000Z',
    ledger: {
      status: 'fed',
      total_trials: 2,
      by_candidate: [{ candidate: 'trend', trials: 2 }],
      trials: [
        {
          trial: 1,
          candidate: 'trend',
          config_hash: 'h1',
          source: 'backtest',
          recorded_at: '2026-10-01T09:00:00.000Z',
        },
      ],
    },
    proposals: loop,
    promotions: loop,
    demotions: loop,
    ...overrides,
  };
}
