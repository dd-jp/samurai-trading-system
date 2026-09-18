import type {
  AssetClass,
  BrokerFillId,
  ClosedTrade,
  ExitReason,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
} from '../../../shared/index.js';
import type { ModelledCostBreakdown } from '../../../shared/store/index.js';

export interface PositionReader {
  getOpenPositions(): Promise<OpenPosition[]>;
  getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
}

export interface LotJournal {
  findByKey(idempotency_key: string): Promise<boolean>;
  writeAheadPosition(position: OpenPosition): Promise<void>;
  updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
}

export interface FillReader {
  hasFill(args: { idempotency_key: string; broker_fill_id: BrokerFillId }): Promise<boolean>;
  getFills(idempotency_key: string): Promise<Fill[]>;
  getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
}

export interface FillJournal {
  applyLotAdvance(advance: LotAdvance): Promise<void>;
  getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null>;
  markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void>;
}

export interface FlattenJournal {
  writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void>;
  resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void>;
  resolveFlattenError(idempotency_key: string, reason: string, resolved_at: Date): Promise<void>;
  isRetryableFlattenError(idempotency_key: string): Promise<boolean>;
  getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]>;
  markFlattenCancelAttempted(idempotency_key: string, attempted_at: Date): Promise<void>;
  markFlattenTerminalUnsweptChecked(idempotency_key: string, checked_at: Date): Promise<void>;
  recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
}

export interface ResidualMarkers {
  markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void>;
  confirmResidualProtected(idempotency_key: string): Promise<void>;
  markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean>;
  markResidualRearmUnsupportedAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean>;
  getResidualRearmUnsupportedAlertedAt(idempotency_key: string): Promise<Date | null>;
  getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]>;
}

export interface LotRetirement {
  sweepTerminalPositions(cutoff: Date): Promise<number>;
  abandonWedgedZeroFillLot(idempotency_key: string, reason: string): Promise<boolean>;
}

export type SharedStore = PositionReader &
  LotJournal &
  FillReader &
  FillJournal &
  FlattenJournal &
  ResidualMarkers &
  LotRetirement;

export interface UnprotectedResidualLot {
  position: OpenPosition;
  unprotected_since: Date;
  alerted_at: Date | null;
  rearm_unsupported_alerted_at: Date | null;
}

export interface UnresolvedFlattenSubmission {
  idempotency_key: string;
  instrument: string;
  status: 'submitting' | 'submitted';
  submitted_at: Date;
  order_state: OrderState | null;
  cancel_attempted_at: Date | null;
  terminal_unswept_checked_at: Date | null;
}

export interface FlattenAttribution {
  lot_idempotency_keys: readonly string[];
  instrument: string;
  side: 'buy' | 'sell';
  lot_held_quantities: readonly LotHeldQuantity[] | null;
  exit_reason: ExitReason | null;
  modelled_cost_breakdown: ModelledCostBreakdown | null;
  size: number;
}

export interface LotAdvance {
  idempotency_key: string;
  fills: readonly Fill[];
  position_update?: { filled_size: number; avg_entry_price: number; order_state: OrderState };
  closed_trade?: ClosedTrade;
}

export interface FlattenSubmissionWriteAhead {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  size: number;
  submitted_at: Date;
  lot_held_quantities: readonly LotHeldQuantity[];
  exit_reason: ExitReason;
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: ModelledCostBreakdown | null;
}
