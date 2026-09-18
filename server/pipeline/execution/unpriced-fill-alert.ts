
export interface UnpricedFillAlert {
  venue: string;
  client_order_id: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  instrument: string;
  qty: number;
  first_seen_at: Date;
  unpriced_for_ms: number;
  age_out_ms: number;
}

export interface UnpricedFillAlertChannel {
  postUnpricedFillAlert(alert: UnpricedFillAlert): Promise<void>;
}
