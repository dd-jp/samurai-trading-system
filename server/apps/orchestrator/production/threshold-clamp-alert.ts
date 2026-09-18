
export interface ThresholdClampAlert {
  trace_id: string;
  where: 'live-read' | 'daily-kill-line-check';
  message: string;
  reported_at: Date;
}

export interface ThresholdClampAlertChannel {
  postThresholdClampAlert(alert: ThresholdClampAlert): void;
}
