export interface CalendarFallbackAlert {
  reason: string;
  fallback_coverage_end: string;
  reported_at: Date;
}

export interface CalendarFallbackAlertChannel {
  postCalendarFallbackAlert(alert: CalendarFallbackAlert): void;
}
