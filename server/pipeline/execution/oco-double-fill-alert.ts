export interface OcoDoubleFillAlert {
  client_order_id: string;
  instrument: string;
  stop_order_id: string;
  target_order_id: string;
  observed_at: Date;
}

export interface OcoDoubleFillAlertChannel {
  postOcoDoubleFillAlert(alert: OcoDoubleFillAlert): Promise<void>;
}
