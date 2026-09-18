
export interface UnrecordedVenuePositionAlert {
  trace_id: string;
  instrument: string;
  qty: number;
  side: 'buy' | 'sell';
  observed_at: Date;
}

export interface UnrecordedVenuePositionAlertChannel {
  postUnrecordedVenuePositionAlert(alert: UnrecordedVenuePositionAlert): Promise<void>;
}
