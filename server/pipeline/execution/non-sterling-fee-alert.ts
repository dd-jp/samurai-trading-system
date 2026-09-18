export interface NonSterlingFeeAlert {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  broker_fill_id: string;
  fee: number;
  fee_currency: string;
  book_currency: string;
}

export interface NonSterlingFeeAlertChannel {
  postNonSterlingFeeAlert(alert: NonSterlingFeeAlert): Promise<void>;
}
