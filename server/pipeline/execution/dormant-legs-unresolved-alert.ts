export interface DormantLegsUnresolvedAlert {
  client_order_id: string;
  instrument: string;
  stuck_ms: number;
  observed_at: Date;
}

export interface DormantLegsUnresolvedAlertChannel {
  postDormantLegsUnresolvedAlert(alert: DormantLegsUnresolvedAlert): Promise<void>;
}
