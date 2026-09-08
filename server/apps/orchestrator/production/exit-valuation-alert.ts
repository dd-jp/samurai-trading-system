/**
 * The operator-escalation port for an EXIT priced against a partly-valued
 * book (#841).
 *
 * ## The gap this closes
 *
 * `computePortfolioView` refuses to produce a view when ANY held instrument's
 * mark cannot be read or is stale (#289 H8, #640). On the entry path that is
 * conservative: no valuation, no order. On the EXIT path it is the opposite —
 * the refusal reached `buildRiskStep`, propagated out of the tick, and was
 * caught by `tick-loop.ts`'s `instrument failed` catch, which logs at `error`
 * and lets the tick continue. Net effect: no exit order, no alert, and one
 * dark name suppressing the flatten of every OTHER position in the book,
 * including names whose marks were perfectly fresh.
 *
 * ADR-0014 makes flat-by-close an invariant, and ADR-0016's universe is
 * leveraged ETPs — carrying one of those overnight because a different
 * instrument's feed went quiet is a materially worse outcome than valuing the
 * book without it. So the exit path now DEGRADES (`unvaluable_marks:
 * 'exclude'`) instead of refusing, and this port is what stops that
 * degradation from being silent.
 *
 * ## Why it is an alert and not a refusal
 *
 * Nothing about the degraded view is used to decide the exit.
 * `RiskManagerImpl.evaluate` returns at `intent_type === 'exit'` before any
 * gate reads `portfolio`, which it consults only for the `risk_snapshot` and
 * the `risk_log` row; Verdict reads only `breakers`. So the degradation costs
 * ACCURACY OF THE RECORD, not correctness of the decision — and an entry
 * cannot reach it (the composition root asks for it on exits only, and
 * `evaluate` refuses an entry on a non-empty `unvalued_instruments` besides).
 * What an operator has to know is that the book has a dark name in it, which
 * is a feed fault they must act on.
 *
 * ## No `Logging…Channel`, and no latch
 *
 * Absent = log-only, with no logging implementation standing in behind it —
 * the same call as `TraderDiagnosticAlertChannel` and
 * `ThresholdClampAlertChannel`, and for the same reason: the seam that raises
 * this already writes an `error`-level line before reaching the port, so a
 * logging implementation would emit every condition twice.
 *
 * Deliberately NOT latched once per process the way `thresholdClampAlerts`
 * is. A bad `risk_thresholds` row is static — one page says everything there
 * ever is to say. A dark mark is transient and recurring, so a latch would
 * swallow the second outage entirely. Flooding is bounded by the condition
 * itself rather than by a throttle: this fires only on a tick that produced
 * an exit intent AND found a dark held mark, and a successful flatten removes
 * the position that made the tick produce one.
 */

/**
 * ## The `trader` seam (#826) — the SAME page, one stage earlier
 *
 * #841's two seams both mean "the exit went out against a book that could not
 * be fully valued". #826 adds a third that means "the exit went out with NO
 * PRICE OF ITS OWN": the instrument's own mark read failed — an Alpaca stall,
 * which `FailoverDataSource` deliberately does not fail over for marks — and
 * `buildFlattenExit` emitted the mandatory flat-by-close exit anyway, with
 * `entry`/`stop`/`target` zeroed and `metadata.unpriced_exit` set.
 *
 * Reported through THIS port rather than a sixteenth channel because the
 * operator's question and action are identical: an exit proceeded despite a
 * market-data failure, and the market-data feed for the named instrument is
 * the thing to look at. A separate transport would split one condition across
 * two chats and double the wiring surface (`AlertChannelSlots`) for no new
 * decision. What differs is the CONSEQUENCE line, which the formatter varies
 * per seam — the risk/verdict seams understate exposure in `risk_log`, while
 * the trader seam leaves the intent's price fields meaningless.
 */
/** One exit priced against a book that could not be fully valued. */
export interface ExitValuationDegradedAlert {
  /** The instrument being EXITED — not the one that could not be valued. */
  instrument: string;
  /**
   * Which seam degraded. `risk` and `verdict` both re-derive the portfolio for
   * the same tick: `risk` sizes/records the exit, `verdict` re-checks breakers
   * at fire time (verdict-spec.md's `breaker` gate, 5). A tick can report both.
   *
   * `trader` (#826) is a different condition on the same subject — see the
   * block above: the EXIT ITSELF has no mark, not merely the rest of the book.
   */
  seam: 'risk' | 'verdict' | 'trader';
  /**
   * The held instruments left out of the valuation — the dark names. On the
   * `trader` seam that is the exited instrument itself, which is the whole
   * point of that seam: the one name that could not be priced is the one being
   * closed.
   */
  unvalued_instruments: readonly string[];
  /**
   * The refusal the strict valuation raised, verbatim — it names each dark
   * instrument AND why (timeout, stale by N ms, …). Carried as text because
   * that is the only form `describeThrown` ever renders.
   */
  reason: string;
  reported_at: Date;
}

export interface ExitValuationDegradedAlertChannel {
  postExitValuationDegradedAlert(alert: ExitValuationDegradedAlert): void;
}
