export interface UnattributedFlattenFillAlert {
  trace_id: string;
  flatten_idempotency_key: string;
  lot_idempotency_key: string;
  instrument: string;
  side: 'buy' | 'sell';
  broker_fill_id: string;
  qty: number;
  observed_at: Date;
}

export interface UnattributedFlattenFillAlertChannel {
  postUnattributedFlattenFillAlert(alert: UnattributedFlattenFillAlert): Promise<void>;
}
