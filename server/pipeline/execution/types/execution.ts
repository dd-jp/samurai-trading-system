import type {
  BarWindow,
  IndicatorSpec,
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import type { AssetClass, Clock, Logger, OrderState } from '../../../shared/index.js';
import type { CostModel, CostVenue } from '../../../tools/backtest/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import type { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import type { FlattenOverfillAlertChannel } from '../flatten-overfill-alert.js';
import type { FlattenReconcileAlertChannel } from '../flatten-reconcile-alert.js';
import type { NonSterlingFeeAlertChannel } from '../non-sterling-fee-alert.js';
import type { ResidualExposureAlertChannel } from '../residual-exposure-alert.js';
import type { UnattributedFlattenFillAlertChannel } from '../unattributed-flatten-fill-alert.js';
import type { UnrecordedVenuePositionAlertChannel } from '../unrecorded-venue-position-alert.js';
import type { UnrecordedVenuePositionThrottle } from '../unrecorded-venue-position-throttle.js';
import type { BrokerAdapter } from './broker.js';
import type {
  FillJournal,
  FillReader,
  FlattenJournal,
  LotJournal,
  LotRetirement,
  PositionReader,
  ResidualMarkers,
  SharedStore,
} from './store.js';

export interface ExecutionConfig {
  simulated: SimulatedAdapterConfig;
}

export interface SimulatedAdapterConfig {
  volatility_indicator: IndicatorSpec;
  adv_window: BarWindow;
  venue?: CostVenue;
}

export interface ExecutionInput {
  trace_id: string;
  clock: Clock;
  broker: BrokerAdapter;
  store: SharedStore;
  costModel: CostModel;
  marketData: MarketDataService;
  config: ExecutionConfig;
  residualExposureAlerts: ResidualExposureAlertChannel;
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  unrecordedVenuePositionAlerts: UnrecordedVenuePositionAlertChannel;
  unrecordedVenuePositionThrottle: UnrecordedVenuePositionThrottle;
  logger: Logger;
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
}

export type SubmitInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'costModel' | 'marketData' | 'config' | 'logger'
> & {
  store: LotJournal & PositionReader & FlattenJournal & ResidualMarkers;
};

export type ResidualReflattenInput = Pick<
  ExecutionInput,
  'trace_id' | 'broker' | 'sessionCalendars' | 'logger'
> & {
  store: LotJournal & FlattenJournal;
};

export type FillIngestInput = Pick<
  ExecutionInput,
  | 'trace_id'
  | 'clock'
  | 'broker'
  | 'residualExposureAlerts'
  | 'flattenOverfillAlerts'
  | 'logger'
  | 'filledZeroSizeThrottle'
  | 'nonSterlingFeeAlerts'
  | 'unattributedFlattenFillAlerts'
> &
  ResidualReflattenInput & {
    store: PositionReader & FillReader & FillJournal & ResidualMarkers;
  };

export type ReconcileInput = Pick<
  ExecutionInput,
  | 'trace_id'
  | 'clock'
  | 'broker'
  | 'residualExposureAlerts'
  | 'flattenReconcileAlerts'
  | 'unrecordedVenuePositionAlerts'
  | 'unrecordedVenuePositionThrottle'
  | 'logger'
> &
  ResidualReflattenInput & {
    store: PositionReader &
      LotJournal &
      FlattenJournal &
      LotRetirement &
      FillReader &
      ResidualMarkers;
  };

export type ResidualSweepInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'residualExposureAlerts' | 'logger'
> &
  ResidualReflattenInput & {
    store: FillReader & ResidualMarkers;
  };

export type WedgedSweepInput = Pick<ExecutionInput, 'trace_id' | 'clock' | 'logger'> & {
  store: PositionReader & LotRetirement;
};

export interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  broker_order_ids: string[] | null;
  order_state: OrderState | null;
  reason: string | null;
  timestamp: Date;
}

export type ReconcileEscalation =
  | 'wedge_cancelled'
  | 'never_confirmed_throttled'
  | 'never_confirmed_cancel_failed'
  | 'never_confirmed_coverage_short'
  | 'sweep_shape_mismatch'
  | 'sweep_abandon_failed'
  | 'residual_sweep_lot_unsettled'
  | 'residual_sweep_size_read_failed'
  | 'residual_sweep_garbage_residual'
  | 'residual_sweep_reflatten_in_flight'
  | 'residual_sweep_reflatten_submitted'
  | 'residual_sweep_rearm_unsupported'
  | 'residual_sweep_rearm_retry_failed';

export interface ReconcileDivergence {
  idempotency_key: string;
  instrument: string;
  store_state: OrderState;
  broker_state: OrderState | null;
  action: 'adopted' | 'rejected' | 'undetermined' | 'unrecorded';
  reason: string;
  escalation?: ReconcileEscalation;
  kind: 'bracket' | 'flatten' | 'unrecorded' | 'sweep';
}

export interface ResidualProtectionSweepResult {
  checked: number;
  divergences: ReconcileDivergence[];
}

export interface ReconcileReport {
  checked: number;
  corrected: number;
  divergences: ReconcileDivergence[];
  swept: number;
  timestamp: Date;
}

export interface Execution {
  execute(verdict: VerdictDecision): Promise<ExecutionResult>;
  ingestFills(): Promise<void>;
  reconcile(): Promise<ReconcileReport>;
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}
