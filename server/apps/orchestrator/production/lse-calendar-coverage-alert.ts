export interface LseCalendarCoverageAlert {
  coverage_end: string;
  days_remaining: number;
  reported_at: Date;
}

export interface LseCalendarCoverageAlertChannel {
  postLseCalendarCoverageAlert(alert: LseCalendarCoverageAlert): void;
}
