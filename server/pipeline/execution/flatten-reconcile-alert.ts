export interface FlattenReconcileAlert {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  reason: string;
  observed_at: Date;
}

export interface FlattenReconcileAlertChannel {
  postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void>;
}
