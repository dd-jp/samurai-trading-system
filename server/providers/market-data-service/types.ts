
export interface Bar {
  instrument: string;
  timeframe: string;
  open_time: Date;
  close_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export interface BarWindow {
  timeframe: string;
  lookback: number;
  partial?: 'error' | 'allow';
}

export interface Mark {
  price: number;
  observed_at: Date;
  source: string;
  asset_class: 'crypto' | 'stocks';
}

export const INDICATOR_KINDS = [
  'sma',
  'ema',
  'rsi',
  'atr',
  'atr_pct',
  'macd_histogram',
  'adx',
  'donchian_pos',
  'bb_kc_squeeze',
] as const;

export type IndicatorKind = (typeof INDICATOR_KINDS)[number];

export interface IndicatorSpec {
  indicator: IndicatorKind;
  params: Record<string, number>;
  lookback: number;
  timeframe: string;
}

export interface IndicatorValue {
  indicator: string;
  value: number;
  as_of_bar_close: Date;
}

export interface Quote {
  bid: number;
  ask: number;
  observed_at: Date;
}

export interface MarketDataStore {
  appendBars(bars: readonly Bar[]): void;
  readBars(instrument: string, timeframe: string, asOf: Date, lookback: number): Bar[];
  upsertLatestMark(instrument: string, mark: Mark): void;
  readLatestMark(instrument: string): Mark | undefined;
}

export interface DataSource {
  fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark>;
  fetchQuote?(instrument: string, asOf: Date): Promise<Quote | null>;
}

export type MarkRead =
  | { readonly ok: true; readonly mark: Mark }
  | { readonly ok: false; readonly error: unknown };

export interface MarketDataService {
  getBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  getIndicator(instrument: string, spec: IndicatorSpec, asOf: Date): Promise<IndicatorValue>;
  getMark(instrument: string, asOf: Date): Promise<Mark>;
  getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>>;
  getSpreadEstimate(instrument: string, asOf: Date): Promise<number | null>;
  getQuote(instrument: string, asOf: Date): Promise<Quote | null>;
  getADV(instrument: string, window: BarWindow, asOf: Date): Promise<number>;
}
