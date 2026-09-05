/**
 * Escalation for a materially degraded tick pass (#1084) — when the
 * per-instrument reentrancy guard (#669) and the per-pass concurrency cap
 * (#692) cause at least half of a tick's planned instruments to be skipped
 * because their previous pass has not finished yet.
 *
 * `startTickLoop`'s `runOnce` (production.ts) already logs every busy skip at
 * `info` — deliberately not raised to `warn`, because the comment there is
 * right that a *small* busy skip is the steady state, not an anomaly: slow
 * crypto debates routinely outlast the tick interval. This module does not
 * change that log or its level; it adds a SEPARATE escalation path for a
 * different event a bare log line cannot surface — a real paper-soak session
 * (#1084) recorded a tick dropping 15 of 20 instruments (75% of the
 * universe), and it reached nobody, because `info` never leaves the log
 * stream.
 *
 * Out of scope by the ticket's own AC: the skip mechanism itself. #692,
 * #1013 and #1040's concurrency mechanics are untouched — only whether a
 * degraded PASS is escalated changes.
 *
 * Same throttle shape as `analysts-adapter.ts` (#431), `mi-coverage.ts`
 * (#752) and `trader-diagnostic-alert.ts` (#698): alert at a threshold, then
 * every 8th tick while the condition persists — never a new pattern.
 */
import { type Logger, sanitizeLogText } from '../../../shared/index.js';

/** One materially-degraded tick pass, reported once the throttle clears it to fire. */
export interface TickSkipAlert {
  /** How many of the planned instruments were skipped this tick. */
  skipped: number;
  /** How many instruments the scheduler planned for this tick — see `isMateriallyDegraded`. */
  planned: number;
  /** The skipped instruments by name. WHICH ones matters as much as how many (#669's own reasoning). */
  skipped_instruments: readonly string[];
  /** How many consecutive ticks have been materially degraded, including this one. */
  consecutive_ticks: number;
  reported_at: Date;
}

/**
 * Where the tick-skip escalation goes. Declared beside its caller
 * (`startTickLoop`, production.ts), like `AnalystSkipAlertChannel` beside
 * `buildAnalystsStep`. `LoggingTickSkipAlertChannel` (console-channels.ts)
 * and `TradeChannelTickSkipAlert` (tick-skip-alert-channel.ts) implement it.
 */
export interface TickSkipAlertChannel {
  postTickSkipAlert(alert: TickSkipAlert): Promise<void>;
}

/**
 * The absolute floor below which a skip never counts as material, regardless
 * of fraction.
 *
 * A fraction alone misfires on a small plan: `Scheduler.nextTick` is
 * session/cadence-gated and can legitimately return as few as 3-4
 * instruments rather than the full universe, and 2 of 4 busy is 50% —
 * exactly the ordinary "one or two instruments running a slow debate" case
 * the #669 busy-log comment calls the steady state, and precisely what
 * #1084's own acceptance criteria says must stay quiet. 3 is chosen because
 * two concurrently-stuck instruments still reads as "two ordinary slow
 * debates"; a third makes it look like the PASS, not the instruments, is
 * what's degraded.
 */
export const TICK_SKIP_ALERT_MIN_INSTRUMENTS = 3;

/**
 * The fraction of the planned tick that must be skipped, alongside the floor
 * above, before a pass counts as materially degraded.
 *
 * Chosen against the six measurements #1084 itself quotes from a real
 * paper-soak session — (skipped/planned): 2/20, 1/20, 3/20, 7/20, 11/20,
 * 15/20. At 0.5: 11/20 (55%) and 15/20 (75%) — the two runs where AT LEAST
 * HALF of the universe went missing — alert; 2/20 and 1/20 stay quiet under
 * the floor above; 3/20 (15%) also stays quiet under the fraction; 7/20 (35%)
 * stays quiet too — just over a third of the universe running long is still
 * short of "the pass itself is degraded", the same "small routine skip" the
 * busy-log's own comment treats as ordinary, just at a bigger denominator.
 * The threshold is INCLUSIVE (`>=`, not `>`) — a pass exactly split down the
 * middle (e.g. 10/20) still fires — so "at least half" is the bar #1084
 * sets: strictly larger than the single-name degradations this repo already
 * escalates (MI coverage #752, analyst skip #431).
 */
export const TICK_SKIP_ALERT_FRACTION = 0.5;

/**
 * True when this tick's busy skip is large enough, in both absolute and
 * proportional terms, to be a materially degraded pass rather than the
 * ordinary "one or two slow debates" case `startTickLoop`'s `info` log
 * already covers quietly. See the two constants above for what each guards
 * against.
 *
 * `planned <= 0` (nothing was scheduled this tick — session/cadence gate,
 * empty universe) is always false, deliberately: a pass with nothing planned
 * has nothing to be degraded ABOUT, so it counts the same as a clean tick and
 * (via `TickSkipThrottle.observe`) clears a running degraded streak. An
 * overnight or weekend gap between two degraded stretches therefore resets
 * the counter — intended, not a gap: the streak is about consecutive
 * *degraded passes*, and a tick that ran nothing is not evidence the fault
 * persisted through the gap either way.
 */
export function isMateriallyDegraded(skipped: number, planned: number): boolean {
  if (planned <= 0) return false;
  return (
    skipped >= TICK_SKIP_ALERT_MIN_INSTRUMENTS && skipped >= planned * TICK_SKIP_ALERT_FRACTION
  );
}

/**
 * Alert on the FIRST materially-degraded tick, unlike the analyst-skip
 * channel's threshold of two (#431).
 *
 * The difference is the same one `ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS`
 * draws (trader-diagnostic-alert.ts): a single instrument's skip is usually
 * transient (a slow crypto debate), but AT LEAST HALF of the planned universe
 * stuck behind a previous pass should never happen in a healthy run —
 * waiting for a second occurrence before saying so buys nothing except a
 * later alert.
 */
export const ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS = 1;

/**
 * How often the alert repeats while the pass stays degraded, counted in
 * further consecutive degraded ticks after the first alert.
 *
 * Every 8th tick is ~2 hours at ADR-0008's 15-minute cadence — the same
 * interval and reasoning as `ALERT_REPEAT_EVERY_SKIPS` /
 * `ALERT_REPEAT_EVERY_NO_DATA` / `ALERT_REPEAT_EVERY_DIAGNOSTICS`: frequent
 * enough that a fault is noticed, rare enough that the shared escalation
 * chat stays readable and does not train the operator to mute it.
 */
export const ALERT_REPEAT_EVERY_DEGRADED_TICKS = 8;

/** Fires at the threshold, then on a bounded repeat while the pass stays degraded. */
function shouldAlertAt(consecutive: number): boolean {
  if (consecutive < ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS) return false;
  return (
    (consecutive - ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS) % ALERT_REPEAT_EVERY_DEGRADED_TICKS === 0
  );
}

/**
 * Consecutive-degraded-tick counter for one running orchestrator.
 *
 * A SINGLE scalar, unlike the analyst-skip and MI-coverage throttles' maps:
 * this is a whole-PASS event. "The pass dropped at least half the universe"
 * has one answer per tick, not one per instrument, so there is nothing to key
 * a map on.
 *
 * In memory and restart-clean, for the reason `consecutiveSkips`
 * (analysts-adapter.ts) is: the counter exists to distinguish an isolated
 * blip from a persistent fault, and a process that just restarted has no
 * evidence about the previous process's ticks. A crash is already alarmed by
 * the heartbeat's silence.
 */
export class TickSkipThrottle {
  #consecutive = 0;

  /**
   * Records this tick's degraded/not-degraded verdict and returns whether
   * this tick is due to alert.
   *
   * Called on EVERY tick, not only busy ones — a clean tick has to clear the
   * run for the same reason a good analyst tick clears `consecutiveSkips`:
   * the alert is about a CONSECUTIVE run of degraded passes, so an
   * intermittent one must not accumulate its way to an alert over a day of
   * otherwise healthy ticks.
   */
  observe(degraded: boolean): { alert: boolean; consecutive: number } {
    if (!degraded) {
      this.#consecutive = 0;
      return { alert: false, consecutive: 0 };
    }
    this.#consecutive += 1;
    return { alert: shouldAlertAt(this.#consecutive), consecutive: this.#consecutive };
  }
}

export interface ReportTickSkipParams {
  /** The instruments still running from a previous pass — `busy` in `runOnce`. */
  skipped: readonly string[];
  /**
   * `ready.length + busy.length`, NOT `plan.instruments.length` — see
   * `production.ts`'s call site. The raw plan length also counts
   * `duplicated` entries, which would inflate the denominator and could
   * silently suppress an alert a smaller, correct denominator would fire.
   */
  planned: number;
  reportedAt: Date;
}

/**
 * Runs one tick's observation through the throttle and posts an alert when
 * due.
 *
 * NEVER THROWS — same posture as `postSkipAlert` (analysts-adapter.ts): a
 * Telegram outage must not turn "the pass is degraded" into "the tick
 * failed", so a delivery failure is logged at `error` and swallowed rather
 * than propagated.
 *
 * Callers must AWAIT this unconditionally, on every tick and BEFORE any
 * early return on an empty ready list. A 100%-skipped tick (every planned
 * instrument still busy) is the single most degraded case this ticket exists
 * to escalate, and an early return placed above this call would silently
 * skip past exactly that case.
 */
export async function reportTickSkip(
  throttle: TickSkipThrottle,
  channel: TickSkipAlertChannel | undefined,
  logger: Logger | undefined,
  params: ReportTickSkipParams,
): Promise<void> {
  const degraded = isMateriallyDegraded(params.skipped.length, params.planned);
  const { alert, consecutive } = throttle.observe(degraded);
  if (!alert || channel === undefined) return;

  const tickSkipAlert: TickSkipAlert = {
    skipped: params.skipped.length,
    planned: params.planned,
    skipped_instruments: params.skipped,
    consecutive_ticks: consecutive,
    reported_at: params.reportedAt,
  };

  try {
    await channel.postTickSkipAlert(tickSkipAlert);
  } catch (error) {
    logger?.log({
      trace_id: 'tick-skip',
      stage: 'tick-loop',
      event: 'tick_skip_alert_send_failed',
      level: 'error',
      message:
        'tick-skip alert could not be delivered — a materially degraded pass is still ' +
        'happening and nobody has been told',
      payload: {
        skipped: tickSkipAlert.skipped,
        planned: tickSkipAlert.planned,
        consecutive_ticks: consecutive,
        error: sanitizeLogText(error instanceof Error ? error.message : String(error)),
      },
    });
  }
}
