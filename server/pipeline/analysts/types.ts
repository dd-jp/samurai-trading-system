
import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock } from '../../shared/index.js';
import type { AnalystView, FailureCause } from '../debate-engine/index.js';

export type { AssetClass };

export interface Signal {
  asset: string;
  asset_class: AssetClass;
}

export const INDICATOR_UNAVAILABLE_COUNTER = 'technical_indicator_unavailable';

export interface IndicatorUnavailableEvent {
  trace_id: string;
  analyst_type: string;
  instrument: string;
  axis: string;
  kind: string;
  required: number;
  received: number;
}

export interface AnalystTelemetry {
  indicatorUnavailable(event: IndicatorUnavailableEvent): void;
}

export const NOOP_ANALYST_TELEMETRY: AnalystTelemetry = {
  indicatorUnavailable(): void {
  },
};

export interface AnalystInput {
  trace_id: string;
  signal: Signal;
  clock: Clock;
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
  calendar: TradingCalendar;
  bar: Date;
  telemetry: AnalystTelemetry;
}

export interface Analyst {
  analyst_type: string;
  applies_to(asset_class: AssetClass): boolean;
  role: 'mandatory' | 'optional';
  run(input: AnalystInput): Promise<AnalystView>;
}

export type AnalystFailureKind = FailureCause;

export interface AnalystFailure {
  analyst_type: string;
  role: 'mandatory' | 'optional';
  reason: string;
  kind: AnalystFailureKind;
}

export interface AnalystRunResult {
  views: AnalystView[];
  analyst_count: number;
  skipped: boolean;
  failures: AnalystFailure[];
}

export { NO_DATA_MARKER } from '../../shared/index.js';
