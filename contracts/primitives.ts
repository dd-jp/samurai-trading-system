
export type AssetClass = 'crypto' | 'stocks';

export type InstrumentSubclass = 'index_etp_3x' | 'single_stock_etp_3x' | 'crypto';

export type Direction = 'bullish' | 'bearish' | 'neutral';

export const STORE_MODES = ['paper', 'live', 'backtest'] as const;

export type StoreMode = (typeof STORE_MODES)[number];

export type OrderState =
  | 'pending'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'closed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'abandoned';

export type TradingArm = 'live' | 'control';
