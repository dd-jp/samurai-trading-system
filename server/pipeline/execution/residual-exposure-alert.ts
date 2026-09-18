
export interface ResidualExposureAlert {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  side: 'buy' | 'sell';
  residual_qty: number;
  residual_qty_is_upper_bound: boolean;
  rearm_unsupported: boolean;
  stop: number;
  target: number;
  observed_at: Date;
}

export interface ResidualExposureAlertChannel {
  postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void>;
}
