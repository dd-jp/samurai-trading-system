/**
 * The operator-escalation port for a Trader diagnostic (#698) — a condition the
 * Trader detected, did not treat as fatal, and kept running through.
 *
 * Declared beside its caller (`buildTraderStep`, direct-bind.ts) the same way
 * `AnalystSkipAlertChannel` is declared beside `buildAnalystsStep` and
 * `FlattenReconcileAlertChannel` beside `reconcile()`. Implemented by
 * the alert catalogue's `traderDiagnosticAlerts` entry (alert-catalogue.ts),
 * which `SAMURAI_ALERTS=telegram` selects at the composition root.
 *
 * There is deliberately NO log-only form (`UNLOGGED_ALERT_IDS`), which is where this
 * departs from the other ten. `buildTraderStep` writes every diagnostic to its
 * own logger at `error` BEFORE it reaches this port, so a log-only
 * implementation would emit each condition twice. An absent channel here means
 * "no second, audible copy" — never "silent".
 *
 * That claim was FALSE as shipped and is now true (#710). The `error` log lived
 * inside the function the throttle gates, so on a condition present every tick
 * it wrote on tick 1, again on tick 9, and nothing in between — seven ticks in
 * eight silent, in exactly the deployment this paragraph promises is safe. The
 * log is now emitted for every entry `observe` returns and only the `alert` ones
 * reach the channel; see `ObservedTraderDiagnostic`.
 *
 * ## Why an alert and not just a `trader_log` row
 *
 * `trader_log` already records every skip reason durably, and #475 made those
 * reasons specific. The gap #698 names is that **a durable row is not an
 * alert**: during a 14-day unattended soak (#238) nobody is reading the table,
 * and every condition reported here is one where the system CONTINUES in a
 * degraded state rather than failing. Nothing else changes when they happen —
 * the heartbeat keeps beating and the ticks keep completing — which is the same
 * argument #431 makes for the analyst-skip channel and ADR-0008 §1 makes for the
 * spend cap's breach alert.
 *
 * CREDENTIALS: composed only of fields the Trader itself chose — a diagnostic
 * kind from a closed union, the asset class, the instrument, and a `detail`
 * string this repo's own code writes. No vendor payload and no bar data reaches
 * it, so there is nothing here to sanitize a credential out of.
 */
import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import { escalatesAt, type TradingArm } from '../../../shared/index.js';

/** One degraded-but-continuing condition, on one instrument, on one tick */
export interface TraderDiagnosticAlert {
  instrument: string;
  diagnostic: TraderDiagnostic;
  /**
   * Which arm reported this. Set only by `lot_carried_past_session_close`
   * (`carried-lot-alert.ts`), whose reporter is built once per arm against
   * that arm's own store: without this, a live and a control lot carried on
   * the same instrument post two alerts an operator cannot tell apart.
   * `undefined` for every other kind, posted by `buildTraderStep`
   * (direct-bind.ts), which does not populate this field.
   */
  arm?: TradingArm;
  /**
   * How many consecutive ticks this instrument has reported this KIND,
   * including this one.
   *
   * The count is a severity signal, NOT a filter — see
   * `ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS`, which is 1. It separates a one-off
   * from an entrenched fault: `session_end_absent_on_non_crypto` once means the
   * equity calendar answered "this venue never closes" on a single tick, and the
   * same condition on the fortieth consecutive tick means it has been doing that
   * for ten hours and the leg has no flatten boundary at all.
   *
   * Neither is routine, and no kind on this channel has a benign single
   * occurrence — that is the standard `TraderDiagnosticKind` is selected
   * against. This paragraph used to reason about `session_end_in_past`, a kind
   * #1389 deleted along with the branch that raised it: a close already in the
   * past is now an ordinary instant inside the post-close grace, answered by
   * flattening against that close rather than by reporting a fault (see
   * `withinFlattenWindow`). Its wording was load-bearing enough to send a
   * reviewer looking for a grace threshold this channel must not have (#710),
   * so it is replaced rather than left pointing at a kind that no longer exists.
   */
  consecutive_ticks: number;
  reported_at: Date;
}

export interface TraderDiagnosticAlertChannel {
  postTraderDiagnosticAlert(alert: TraderDiagnosticAlert): Promise<void>;
}

/**
 * One distinct diagnostic kind observed on one tick, with its run length and
 * whether it is ALSO due to escalate.
 *
 * The `alert` flag exists so the two halves can be throttled differently, which
 * is the correction #710's review forced. `observe` used to return only the due
 * entries, and the caller's `error` log lived downstream of that filter — so a
 * condition present on every tick was logged on tick 1, then on tick 9, and
 * NOWHERE in between, while two docblocks in this file promised the log was
 * unconditional. ADR-0008 §1's mute-the-channel argument is about a shared
 * Telegram chat and has no bearing on a log file, so throttling the durable
 * half was never justified in the first place.
 */
export interface ObservedTraderDiagnostic {
  diagnostic: TraderDiagnostic;
  consecutive_ticks: number;
  /** True at the threshold and on each bounded repeat — see `shouldAlertAtDiagnosticCount` */
  alert: boolean;
}

/**
 * Alert on the FIRST occurrence, unlike the analyst-skip channel's threshold of
 * two (#431).
 *
 * The difference is what the condition means, not how confident we are. A
 * skipped analyst tick is a blip that is usually transient, so story 25 asks for
 * two before escalating. Every diagnostic on `TraderDiagnosticKind` is instead
 * something that should NEVER happen in a healthy run — corrupt bar data, or a
 * calendar that cannot answer a question it exists to answer — and waiting for a
 * second one buys nothing except a later alert.
 */
export const ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS = 1;

/**
 * How often the alert repeats while the condition persists, counted in further
 * consecutive ticks after the first alert.
 *
 * A repeat is required rather than a one-shot latch, for the reason
 * `ALERT_REPEAT_EVERY_SKIPS` gives: a single alert that lands at hour 0.5 and is
 * missed leaves 14 days of silence that look exactly like a working system.
 *
 * A repeat is also BOUNDED rather than every tick, for the reason ADR-0008 §1
 * gives about the spend cap firing once instead of ~1,000 times: "that is how an
 * operator learns to mute a channel that also carries kill-threshold breaches."
 * This channel shares the escalation chat with those breaches, so flooding it is
 * not merely noisy — it degrades an unrelated alert that matters more.
 *
 * The flooding risk here is real and not hypothetical.
 * `session_end_absent_on_non_crypto` fires on EVERY tick for an affected
 * instrument, so at ADR-0008's 15-minute cadence an unthrottled channel would
 * post ~96 messages per instrument per day. Every 8th tick is ~2 hours: frequent
 * enough to be noticed, rare enough to stay readable — the same interval and the
 * same reasoning as the analyst-skip repeat.
 */
export const ALERT_REPEAT_EVERY_DIAGNOSTICS = 8;

const DIAGNOSTIC_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS,
  every: ALERT_REPEAT_EVERY_DIAGNOSTICS,
};

export function shouldAlertAtDiagnosticCount(consecutive: number): boolean {
  return escalatesAt(consecutive, DIAGNOSTIC_CADENCE);
}

/**
 * Consecutive-tick counters for one running orchestrator, keyed by instrument
 * AND diagnostic kind (#698).
 *
 * **Keyed per KIND, not per instrument.** ADR-0008 §1 had to make exactly this
 * correction for the spend cap's own latch, and the reasoning transfers: under a
 * single per-instrument counter, a transient `atr_not_finite` would fire, set
 * the counter, and then recover — and a `session_end_absent_on_non_crypto`
 * appearing later would be counted as a continuation of a run it has nothing to
 * do with. One
 * condition must not be able to consume another's alert, nor reset it.
 *
 * In memory and restart-clean, for the reason `consecutiveSkips` is: the counter
 * distinguishes a blip from a persistent fault, and a process that just started
 * has no evidence about the previous process's ticks. A crash is already alarmed
 * by the heartbeat's silence.
 */
export class TraderDiagnosticThrottle {
  readonly #consecutive = new Map<string, number>();

  /**
   * Records this tick's diagnostics for one instrument and returns EVERY
   * distinct kind observed, each carrying its run length and whether it is due
   * to alert.
   *
   * Returning the non-alerting ones too is deliberate: the caller logs all of
   * them at `error` and posts only the due ones, so the durable record stays
   * per-tick while the shared Telegram chat stays throttled (#710).
   *
   * `present` is the COMPLETE set for this tick, because clearing matters as
   * much as counting: a kind that did not recur has recovered, and its run must
   * reset so an intermittent fault cannot accumulate its way to an alert over a
   * week of otherwise healthy ticks.
   *
   * **A kind repeated within one tick counts ONCE (#710 review).** The unit is
   * the tick, not the observation: `routeDecision` evaluates
   * `withinFlattenWindow` for the held position and then passes the same
   * `diagnostics` array into `buildBracket`, which evaluates it again for the
   * scale-in — so one tick can hand the same kind in twice. Counting entries
   * would make `consecutive_ticks` inflate 2x, which both lies to the operator
   * in the alert text and fires the bounded repeat at twice its intended
   * cadence.
   *
   * Deduped HERE rather than by threading the first verdict through the call
   * chain, because that fix only holds until a third call site appears; this
   * one is a property of the counter and survives the caller changing shape.
   */
  observe(instrument: string, present: readonly TraderDiagnostic[]): ObservedTraderDiagnostic[] {
    const seen = new Set<string>();
    const observed: ObservedTraderDiagnostic[] = [];

    // First occurrence of each kind wins. Two entries of one kind in a tick
    // describe the same condition, so their `detail` strings differ only by
    // where they were noticed, and the earlier one is the position-level view
    const distinct = new Map<string, TraderDiagnostic>();
    for (const diagnostic of present) {
      if (!distinct.has(diagnostic.kind)) distinct.set(diagnostic.kind, diagnostic);
    }

    for (const diagnostic of distinct.values()) {
      const key = `${instrument}\0${diagnostic.kind}`;
      seen.add(key);
      const count = (this.#consecutive.get(key) ?? 0) + 1;
      this.#consecutive.set(key, count);
      observed.push({
        diagnostic,
        consecutive_ticks: count,
        alert: shouldAlertAtDiagnosticCount(count),
      });
    }

    // Clear the runs for kinds this instrument did NOT report this tick. Scoped
    // to this instrument's own keys: a quiet tick on SPY says nothing about
    // whether BTC-USD's calendar is still broken
    const prefix = `${instrument}\0`;
    for (const key of this.#consecutive.keys()) {
      if (key.startsWith(prefix) && !seen.has(key)) this.#consecutive.delete(key);
    }

    return observed;
  }
}
