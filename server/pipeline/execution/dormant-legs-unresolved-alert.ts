/**
 * A related-order pair `lookup` (saxo-adapter.ts) finds dormant — no master
 * on the open-orders list, every leg `NotWorking` — whose master's OWN
 * audit-trail row never reaches a terminal status either. #1215 round 2
 * bound two coordinator rulings that are in direct tension for exactly this
 * state: (a) never cancel a venue order without audit-trail evidence it is
 * done, and (c) never silently defer a wedged lot forever. Neither rules the
 * other out on its own — the answer is to keep NOT cancelling (ruling a
 * wins the action), but to page the operator, repeatedly, for as long as
 * the audit trail stays silent (ruling c wins the visibility). See
 * `escalateIfStale`'s own doc (saxo-adapter.ts) for the consecutive-poll
 * bound this fires on.
 *
 * Posted instead of thrown, deliberately, and REQUIRED with no default at
 * the constructor — the same "tested mechanism nothing calls" gap
 * `LegResizeUnverifiedAlertChannel` refuses (its own doc), which this repo
 * keeps refiling as its dominant defect class.
 *
 * CREDENTIALS: composed only of fields this module chose — no venue error
 * text or response body reaches it.
 */
export interface DormantLegsUnresolvedAlert {
  /** The bracket's own `client_order_id` — the master's `ExternalReference`. */
  client_order_id: string;
  instrument: string;
  /**
   * How long the corroboration has been stuck non-terminal, wall-clock from
   * the first deferred poll — reporting only. The alert's own bound is a
   * consecutive-poll count, not this duration; see `escalateIfStale`.
   */
  stuck_ms: number;
  observed_at: Date;
}

export interface DormantLegsUnresolvedAlertChannel {
  postDormantLegsUnresolvedAlert(alert: DormantLegsUnresolvedAlert): Promise<void>;
}
