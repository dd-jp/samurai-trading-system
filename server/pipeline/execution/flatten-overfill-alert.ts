export interface FlattenOverfillWarning {
  trace_id: string;
  idempotency_key: string;
  unattributed_qty: number;
  observed_at: Date;
}

export interface FlattenOverfillAlertChannel {
  postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void>;
}
