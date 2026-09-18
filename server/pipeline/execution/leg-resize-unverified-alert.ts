export interface LegResizeUnverifiedAlert {
  client_order_id: string;
  instrument: string;
  requested_qty: number | null;
  filled_qty: number;
  observed_at: Date;
}

export interface LegResizeUnverifiedAlertChannel {
  postLegResizeUnverifiedAlert(alert: LegResizeUnverifiedAlert): Promise<void>;
}
