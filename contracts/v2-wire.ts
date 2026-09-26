import type { ControlAction, SleeveAction } from './v2.js';
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
}

export interface LossBudgetWire {
  readonly year: number;
  readonly capital_stale: boolean;
  readonly trading_date: string;
  readonly start_capital_gbp: number;
  readonly loss_cap_gbp: number;
  readonly step_marks_gbp: readonly number[];
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

export interface V2OverviewWire {
  readonly contract_version: string;
  readonly generated_at: string;
  readonly mode: V2ModeWire;
  readonly loss_budget: PanelWire<LossBudgetWire>;
  readonly control: ControlWire;
  readonly decisions: PanelWire<DecisionsWire>;
  readonly llm_spend: PanelWire<LlmSpendWire>;
  readonly heartbeat: HeartbeatWire;
}

export const CONTROL_REASON_MAX_CHARS = 250;

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

type PanelFields = keyof Extract<PanelWire<object>, { status: 'not-yet-fed' }>;

function fieldsOf<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K & (Exclude<keyof T, K[number]> extends never ? unknown : never),
  ): K => keys;
}

const V2_WIRE_FIELD_NAMES = {
  panel: fieldsOf<Record<PanelFields, unknown>>()(['status', 'owner', 'ticket']),
  overview: fieldsOf<V2OverviewWire>()([
    'contract_version',
    'generated_at',
    'mode',
    'loss_budget',
    'control',
    'decisions',
    'llm_spend',
    'heartbeat',
  ]),
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
};

export function v2WireFieldPaths(): string[] {
  return Object.entries(V2_WIRE_FIELD_NAMES).flatMap(([type, keys]) =>
    keys.map((key) => `${type}.${key}`),
  );
}

export const V2_CONTRACT_VERSION = contractVersionOf(v2WireFieldPaths());
