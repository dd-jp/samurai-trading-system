
export type ProviderState =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'error'
  | 'not_configured';

export interface AlpacaBalanceWire {
  cash: number;
  equity: number;
  buying_power: number | null;
}

export interface ProviderTile {
  provider: 'alpaca' | 'polygon';
  state: ProviderState;
  detail: string;
  observed_at: string | null;
}

export interface AlpacaTile extends ProviderTile {
  provider: 'alpaca';
  balance: AlpacaBalanceWire | null;
}

export interface PolygonTile extends ProviderTile {
  provider: 'polygon';
}

export interface ProviderStatusPanel {
  alpaca: AlpacaTile;
  polygon: PolygonTile;
}
