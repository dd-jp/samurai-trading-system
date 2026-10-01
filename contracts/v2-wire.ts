import type { ControlAction, SleeveAction, Venue } from './v2.js';
import { contractVersionOf } from './version.js';

export type PanelWire<T> =
  | ({ readonly status: 'fed' } & T)
  | { readonly status: 'empty' }
  | { readonly status: 'not-yet-fed'; readonly owner: string; readonly ticket: string };

export type V2ModeWire = 'paper' | 'dry-run';

export interface LossBudgetBookWire {
  readonly book_id: string;
  readonly sleeve_id: string;
  readonly variant: string;
  readonly trading_date: string;
  readonly ytd_loss_gbp: number;
  readonly day_loss_gbp: number;
  readonly size_multiplier: number;
  readonly entries_blocked: boolean;
  readonly loss_cap_gbp: number | null;
  readonly step_marks_gbp: readonly [number, number, number] | null;
  readonly daily_cap_gbp: number | null;
}

export interface LossBudgetWire {
  readonly year: number;
  readonly capital_stale: boolean;
  readonly trading_date: string;
  readonly start_capital_gbp: number;
  readonly loss_cap_gbp: number;
  readonly step_marks_gbp: readonly [number, number, number];
  readonly daily_cap_gbp: number;
  readonly ytd_loss_gbp: number;
  readonly day_loss_gbp: number;
  readonly books: readonly LossBudgetBookWire[];
}

export type ControlDisplayStateWire = 'running' | 'paused' | 'halted-manual' | 'halted-loss-budget';

export interface ControlRowWire {
  readonly control_id: number;
  readonly action: ControlAction;
  readonly reason: string;
  readonly source: string;
  readonly set_at: string;
}

export interface ControlWire {
  readonly state: ControlDisplayStateWire;
  readonly in_force: ControlRowWire | null;
  readonly loss_budget_halted_books: readonly string[];
  readonly history: readonly ControlRowWire[];
}

export interface DecisionWire {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: string;
  readonly direction: string;
  readonly action: SleeveAction;
  readonly vetoed: boolean;
  readonly reason: string;
  readonly confidence: number;
}

export interface DecisionsWire {
  readonly trading_date: string;
  readonly decisions: readonly DecisionWire[];
}

export interface LlmSpendModelWire {
  readonly model: string;
  readonly cost_usd: number;
}

export interface LlmSpendDayWire {
  readonly day: string;
  readonly cost_usd: number;
}

export interface LlmSpendWire {
  readonly month_start: string;
  readonly spent_usd: number | null;
  readonly budget_usd: number;
  readonly calls_stopped: boolean;
  readonly by_model: readonly LlmSpendModelWire[];
  readonly by_day: readonly LlmSpendDayWire[];
}

export interface LastCycleWire {
  readonly trading_date: string;
  readonly recorded_at: string;
}

export interface NextCycleWire {
  readonly due_date: string;
}

export interface PingWire {
  readonly pinged_at: string;
}

export interface HeartbeatWire {
  readonly last_cycle: PanelWire<LastCycleWire>;
  readonly next_due: PanelWire<NextCycleWire>;
  readonly last_ping: PanelWire<PingWire>;
}

export type MarkWire =
  | {
      readonly status: 'fresh';
      readonly bar_date: string;
      readonly price_quote: number;
      readonly price_gbp: number;
      readonly market_value_gbp: number;
      readonly unrealised_gbp: number;
    }
  | { readonly status: 'stale'; readonly bar_date: string | null }
  | { readonly status: 'unavailable' };

export type FreshMarkWire = Extract<MarkWire, { status: 'fresh' }>;
export type StaleMarkWire = Extract<MarkWire, { status: 'stale' }>;

export type QuoteCurrencyWire = 'USD' | 'GBP';

export interface PositionWire {
  readonly book_id: string;
  readonly variant: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly currency: QuoteCurrencyWire;
  readonly qty: number;
  readonly entry_gbp: number;
  readonly stop_gbp: number | null;
  readonly opened_date: string;
  readonly marks_held: number;
  readonly mark: MarkWire;
}

export interface VenueTotalWire {
  readonly venue: Venue;
  readonly currency: QuoteCurrencyWire;
  readonly positions_value_quote: number | null;
  readonly positions_value_gbp: number | null;
}

export interface BookCashWire {
  readonly book_id: string;
  readonly variant: string;
  readonly cash_gbp: number;
}

export interface FxRateWire {
  readonly gbp_usd: number;
  readonly year: number;
  readonly source: string;
}

export interface PositionsWire {
  readonly as_of: string;
  readonly fx: FxRateWire | null;
  readonly positions: readonly PositionWire[];
  readonly cash: readonly BookCashWire[];
  readonly venues: readonly VenueTotalWire[];
  readonly total_gbp: number | null;
}

export interface V2OverviewWire {
  readonly contract_version: string;
  readonly generated_at: string;
  readonly mode: V2ModeWire;
  readonly loss_budget: PanelWire<LossBudgetWire>;
  readonly control: ControlWire;
  readonly positions: PanelWire<PositionsWire>;
  readonly decisions: PanelWire<DecisionsWire>;
  readonly llm_spend: PanelWire<LlmSpendWire>;
  readonly heartbeat: HeartbeatWire;
}

export const CONTROL_REASON_MAX_CHARS = 250;
export const JOURNAL_FILTER_MAX_CHARS = 64;

export interface ControlRequestWire {
  readonly action: ControlAction;
  readonly reason: string;
  readonly idempotency_key: string;
}

export interface ControlResponseWire {
  readonly contract_version: string;
  readonly control: ControlRowWire;
  readonly replayed: boolean;
}

export type NotYetFedWire = Extract<PanelWire<object>, { status: 'not-yet-fed' }>;

export type JournalActionFilterWire = SleeveAction | 'vetoed';

export interface JournalFillWire {
  readonly fill_id: string;
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
  readonly recorded_at: string;
}

export interface JournalOrderWire {
  readonly client_order_id: string;
  readonly book_id: string;
  readonly instrument: string;
  readonly venue: string;
  readonly leg: string;
  readonly side: string;
  readonly dry_run: boolean;
  readonly outcome: string;
  readonly payload: unknown;
  readonly recorded_at: string;
  readonly fills: readonly JournalFillWire[];
}

export interface JournalDecisionWire {
  readonly decision_id: string;
  readonly book_id: string;
  readonly variant: string;
  readonly instrument: string;
  readonly venue: string;
  readonly direction: string;
  readonly action: SleeveAction;
  readonly vetoed: boolean;
  readonly veto: string | null;
  readonly reason: string;
  readonly confidence: number;
  readonly size_shares: number;
  readonly stop_price: number | null;
  readonly inputs_hash: string;
  readonly debate_id: string | null;
  readonly payload: unknown;
  readonly recorded_at: string;
  readonly orders: readonly JournalOrderWire[];
}

export interface JournalRefusalWire {
  readonly refusal_id: number;
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
  readonly book_id: string | null;
  readonly instrument: string | null;
  readonly recorded_at: string;
  readonly feature_off: string | null;
}

export interface JournalDayWire {
  readonly trading_date: string;
  readonly decisions: readonly JournalDecisionWire[];
  readonly unlinked_orders: readonly JournalOrderWire[];
  readonly refusals: readonly JournalRefusalWire[];
}

export interface JournalWire {
  readonly contract_version: string;
  readonly days: readonly JournalDayWire[];
  readonly next_before: string | null;
}

export interface TrialWire {
  readonly trial: number;
  readonly candidate: string;
  readonly config_hash: string;
  readonly source: string;
  readonly recorded_at: string;
}

export interface CandidateTrialsWire {
  readonly candidate: string;
  readonly trials: number;
}

export interface ResearchLedgerWire {
  readonly total_trials: number;
  readonly by_candidate: readonly CandidateTrialsWire[];
  readonly trials: readonly TrialWire[];
}

export interface ResearchWire {
  readonly contract_version: string;
  readonly generated_at: string;
  readonly ledger: PanelWire<ResearchLedgerWire>;
  readonly proposals: NotYetFedWire;
  readonly promotions: NotYetFedWire;
  readonly demotions: NotYetFedWire;
}

export interface EquityPointWire {
  readonly trading_date: string;
  readonly equity_gbp: number;
}

export interface BookPerformanceWire {
  readonly book_id: string;
  readonly sleeve_id: string;
  readonly variant: string;
  readonly days: number;
  readonly sharpe: number | null;
  readonly max_drawdown: number;
  readonly equity: readonly EquityPointWire[];
}

export interface PerformanceWire {
  readonly books: readonly BookPerformanceWire[];
}

// entry_offset_bps is null for an entry at a limit its sleeve set itself (#1815)
export interface EntryOffsetTradesWire {
  readonly entry_offset_bps: number | null;
  readonly closed_trades: number;
}

export interface ClosedTradesBookWire {
  readonly book_id: string;
  readonly variant: string;
  readonly closed_trades: number;
  readonly by_entry_offset: readonly EntryOffsetTradesWire[];
}

export interface TradeCountWire {
  readonly target: number;
  readonly books: readonly ClosedTradesBookWire[];
}

export interface EvidenceWire {
  readonly contract_version: string;
  readonly generated_at: string;
  readonly performance: PanelWire<PerformanceWire>;
  readonly vs_arm2: NotYetFedWire;
  readonly vs_benchmark: NotYetFedWire;
  readonly trade_count: PanelWire<TradeCountWire>;
  readonly arm2_test: NotYetFedWire;
  readonly band: NotYetFedWire;
  readonly gate: NotYetFedWire;
}

export interface ReconcileDiffWire {
  readonly kind: string;
  readonly instrument: string | null;
  readonly order_id: string | null;
  readonly store: number | null;
  readonly broker: number | null;
}

export interface ReconcileRunWire {
  readonly trading_date: string;
  readonly venue: string;
  readonly source: string;
  readonly status: string;
  readonly book_ids: readonly string[];
  readonly diffs: readonly ReconcileDiffWire[];
  readonly detail: string;
  readonly recorded_at: string;
}

export interface ReconcileRunsWire {
  readonly runs: readonly ReconcileRunWire[];
}

export interface ReconcileWire {
  readonly contract_version: string;
  readonly reconcile: PanelWire<ReconcileRunsWire>;
}

export interface TaxWire {
  readonly contract_version: string;
  readonly year: number | null;
  readonly disposals: NotYetFedWire;
}

type PanelFields = keyof NotYetFedWire;

function fieldsOf<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K & (Exclude<keyof T, K[number]> extends never ? unknown : never),
  ): K => keys;
}

export const V2_WIRE_FIELD_NAMES = {
  panel: fieldsOf<Record<PanelFields, unknown>>()(['status', 'owner', 'ticket']),
  overview: fieldsOf<V2OverviewWire>()([
    'contract_version',
    'generated_at',
    'mode',
    'loss_budget',
    'control',
    'positions',
    'decisions',
    'llm_spend',
    'heartbeat',
  ]),
  positions: fieldsOf<PositionsWire>()(['as_of', 'fx', 'positions', 'cash', 'venues', 'total_gbp']),
  position: fieldsOf<PositionWire>()([
    'book_id',
    'variant',
    'instrument',
    'venue',
    'currency',
    'qty',
    'entry_gbp',
    'stop_gbp',
    'opened_date',
    'marks_held',
    'mark',
  ]),
  freshMark: fieldsOf<FreshMarkWire>()([
    'status',
    'bar_date',
    'price_quote',
    'price_gbp',
    'market_value_gbp',
    'unrealised_gbp',
  ]),
  staleMark: fieldsOf<StaleMarkWire>()(['status', 'bar_date']),
  venueTotal: fieldsOf<VenueTotalWire>()([
    'venue',
    'currency',
    'positions_value_quote',
    'positions_value_gbp',
  ]),
  bookCash: fieldsOf<BookCashWire>()(['book_id', 'variant', 'cash_gbp']),
  fxRate: fieldsOf<FxRateWire>()(['gbp_usd', 'year', 'source']),
  lossBudget: fieldsOf<LossBudgetWire>()([
    'year',
    'capital_stale',
    'trading_date',
    'start_capital_gbp',
    'loss_cap_gbp',
    'step_marks_gbp',
    'daily_cap_gbp',
    'ytd_loss_gbp',
    'day_loss_gbp',
    'books',
  ]),
  lossBudgetBook: fieldsOf<LossBudgetBookWire>()([
    'book_id',
    'sleeve_id',
    'variant',
    'trading_date',
    'ytd_loss_gbp',
    'day_loss_gbp',
    'size_multiplier',
    'entries_blocked',
    'loss_cap_gbp',
    'step_marks_gbp',
    'daily_cap_gbp',
  ]),
  control: fieldsOf<ControlWire>()(['state', 'in_force', 'loss_budget_halted_books', 'history']),
  controlRow: fieldsOf<ControlRowWire>()(['control_id', 'action', 'reason', 'source', 'set_at']),
  decisions: fieldsOf<DecisionsWire>()(['trading_date', 'decisions']),
  decision: fieldsOf<DecisionWire>()([
    'book_id',
    'trading_date',
    'instrument',
    'venue',
    'direction',
    'action',
    'vetoed',
    'reason',
    'confidence',
  ]),
  llmSpend: fieldsOf<LlmSpendWire>()([
    'month_start',
    'spent_usd',
    'budget_usd',
    'calls_stopped',
    'by_model',
    'by_day',
  ]),
  llmSpendModel: fieldsOf<LlmSpendModelWire>()(['model', 'cost_usd']),
  llmSpendDay: fieldsOf<LlmSpendDayWire>()(['day', 'cost_usd']),
  heartbeat: fieldsOf<HeartbeatWire>()(['last_cycle', 'next_due', 'last_ping']),
  lastCycle: fieldsOf<LastCycleWire>()(['trading_date', 'recorded_at']),
  nextCycle: fieldsOf<NextCycleWire>()(['due_date']),
  ping: fieldsOf<PingWire>()(['pinged_at']),
  controlRequest: fieldsOf<ControlRequestWire>()(['action', 'reason', 'idempotency_key']),
  controlResponse: fieldsOf<ControlResponseWire>()(['contract_version', 'control', 'replayed']),
  journal: fieldsOf<JournalWire>()(['contract_version', 'days', 'next_before']),
  journalDay: fieldsOf<JournalDayWire>()([
    'trading_date',
    'decisions',
    'unlinked_orders',
    'refusals',
  ]),
  journalDecision: fieldsOf<JournalDecisionWire>()([
    'decision_id',
    'book_id',
    'variant',
    'instrument',
    'venue',
    'direction',
    'action',
    'vetoed',
    'veto',
    'reason',
    'confidence',
    'size_shares',
    'stop_price',
    'inputs_hash',
    'debate_id',
    'payload',
    'recorded_at',
    'orders',
  ]),
  journalOrder: fieldsOf<JournalOrderWire>()([
    'client_order_id',
    'book_id',
    'instrument',
    'venue',
    'leg',
    'side',
    'dry_run',
    'outcome',
    'payload',
    'recorded_at',
    'fills',
  ]),
  journalFill: fieldsOf<JournalFillWire>()([
    'fill_id',
    'qty',
    'price_gbp',
    'fee_gbp',
    'recorded_at',
  ]),
  journalRefusal: fieldsOf<JournalRefusalWire>()([
    'refusal_id',
    'scope',
    'parameter',
    'ticket',
    'message',
    'book_id',
    'instrument',
    'recorded_at',
    'feature_off',
  ]),
  research: fieldsOf<ResearchWire>()([
    'contract_version',
    'generated_at',
    'ledger',
    'proposals',
    'promotions',
    'demotions',
  ]),
  researchLedger: fieldsOf<ResearchLedgerWire>()(['total_trials', 'by_candidate', 'trials']),
  candidateTrials: fieldsOf<CandidateTrialsWire>()(['candidate', 'trials']),
  trial: fieldsOf<TrialWire>()(['trial', 'candidate', 'config_hash', 'source', 'recorded_at']),
  equityPoint: fieldsOf<EquityPointWire>()(['trading_date', 'equity_gbp']),
  bookPerformance: fieldsOf<BookPerformanceWire>()([
    'book_id',
    'sleeve_id',
    'variant',
    'days',
    'sharpe',
    'max_drawdown',
    'equity',
  ]),
  performance: fieldsOf<PerformanceWire>()(['books']),
  closedTradesBook: fieldsOf<ClosedTradesBookWire>()([
    'book_id',
    'variant',
    'closed_trades',
    'by_entry_offset',
  ]),
  entryOffsetTrades: fieldsOf<EntryOffsetTradesWire>()(['entry_offset_bps', 'closed_trades']),
  tradeCount: fieldsOf<TradeCountWire>()(['target', 'books']),
  evidence: fieldsOf<EvidenceWire>()([
    'contract_version',
    'generated_at',
    'performance',
    'vs_arm2',
    'vs_benchmark',
    'trade_count',
    'arm2_test',
    'band',
    'gate',
  ]),
  reconcile: fieldsOf<ReconcileWire>()(['contract_version', 'reconcile']),
  reconcileRuns: fieldsOf<ReconcileRunsWire>()(['runs']),
  reconcileRun: fieldsOf<ReconcileRunWire>()([
    'trading_date',
    'venue',
    'source',
    'status',
    'book_ids',
    'diffs',
    'detail',
    'recorded_at',
  ]),
  reconcileDiff: fieldsOf<ReconcileDiffWire>()([
    'kind',
    'instrument',
    'order_id',
    'store',
    'broker',
  ]),
  tax: fieldsOf<TaxWire>()(['contract_version', 'year', 'disposals']),
};

export function v2WireFieldPaths(): string[] {
  return Object.entries(V2_WIRE_FIELD_NAMES).flatMap(([type, keys]) =>
    keys.map((key) => `${type}.${key}`),
  );
}

export const V2_CONTRACT_VERSION = contractVersionOf(v2WireFieldPaths());
