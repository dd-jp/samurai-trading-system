export interface UnresolvedPriceUnitAlert {
  client_order_id: string;
  broker_fill_id: string;
  uic: number;
  observed_at: Date;
}

export interface UnresolvedPriceUnitAlertChannel {
  postUnresolvedPriceUnitAlert(alert: UnresolvedPriceUnitAlert): Promise<void>;
}
