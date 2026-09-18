export interface ExitValuationDegradedAlert {
  instrument: string;
  seam: 'risk' | 'verdict' | 'trader';
  unvalued_instruments: readonly string[];
  reason: string;
  reported_at: Date;
}

export interface ExitValuationDegradedAlertChannel {
  postExitValuationDegradedAlert(alert: ExitValuationDegradedAlert): void;
}
