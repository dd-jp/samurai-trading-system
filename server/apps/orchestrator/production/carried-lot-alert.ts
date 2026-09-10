/**
 * The audible half of #1389: **a lot that is still open after the flatten
 * grace expired.**
 *
 * ## Why this exists as a separate detector at all
 *
 * #1389 extends ADR-0014's window `flatten_after_close_ms` past the bell, which
 * converts an unbounded silent failure into a bounded one. It does not make the
 * failure impossible: a pass saturated through the whole window AND the whole
 * grace, or a process down across both, still carries the lot — and
 * `flatten-tail-priority.ts`'s coverage bound is unchanged. ADR-0014's
 * 2026-08-16 amendment calls flat-by-close "an invariant with no exception
 * case", so the residual failure mode has to be AUDIBLE rather than merely
 * rarer. That is this file's whole job.
 *
 * ## Why it runs on the fill-sync poll and not on a tick
 *
 * There is no tick. `UniverseScheduler` gates the plan on the calendar (plus
 * #1389's own grace tail), so by definition nothing on the tick path is still
 * running at the moment the grace expires — the condition this detects is
 * precisely the condition under which the tick loop has already stopped for the
 * day. The fill-sync loop (`fill-sync.ts`) has no market-hours gate and is the
 * only machinery running after the bell, which makes it the only place this
 * check CAN live.
 *
 * ## What "carried" means, precisely
 *
 * A lot is carried when a session close has passed SINCE IT OPENED:
 * `sessionStart(now)` — the most recent close at or before `now` — is later
 * than `lot.opened_at`. That test is what keeps an ordinary intraday lot quiet:
 * a position opened at 15:30 today sits after today's `sessionStart` (which is
 * YESTERDAY's close), so it is not carried, while a position opened yesterday
 * is before it and is.
 *
 * It is deliberately NOT "the venue is shut". A lot carried overnight is still
 * a violation at 15:00 the next day with the market open, and #1389's ruling is
 * that such a lot is ALERTED rather than flattened pre-open — trading into an
 * opening auction is a real-money decision David has not made. So this keeps
 * reporting until the lot is gone.
 *
 * ## Why the repeat is a wall clock and not a poll count
 *
 * `TraderDiagnosticThrottle` counts CONSECUTIVE TICKS and repeats every 8
 * (`ALERT_REPEAT_EVERY_DIAGNOSTICS`), which at ADR-0008's 15-minute cadence is
 * about two hours — the interval its own docblock argues for. This detector
 * runs on the 15-SECOND fill poll, so the identical count would repeat every
 * two minutes and flood the escalation chat that also carries kill-threshold
 * breaches, which is the exact outcome ADR-0008 §1 refuses. Keeping the
 * INTERVAL rather than the count is what preserves that decision across a
 * detector with a different cadence.
 */
import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';
import type { Clock, OpenPosition } from '../../../shared/index.js';
import { heldQuantitiesFor } from '../../../shared/index.js';
import type { Logger } from '../types.js';
import type {
  TraderDiagnosticAlert,
  TraderDiagnosticAlertChannel,
} from './trader-diagnostic-alert.js';

/**
 * How long before the same carried lot is reported again — see the file
 * docblock for why this is an interval rather than a poll count.
 *
 * Two hours, matching what `ALERT_REPEAT_EVERY_DIAGNOSTICS` (8) works out to at
 * the 15-minute tick cadence its own doc reasons about. Frequent enough that a
 * missed first alert does not leave the rest of a soak silent, rare enough that
 * the channel stays readable.
 */
export const CARRIED_LOT_ALERT_REPEAT_MS = 2 * 60 * 60 * 1_000;

/**
 * Wall-clock repeat throttle for the carried-lot alert, keyed by instrument AND
 * the close that was missed.
 *
 * Keyed per close rather than per instrument so a lot carried across a SECOND
 * session re-alerts immediately instead of waiting out a repeat interval that
 * started against the first — the same "one condition must not consume
 * another's alert" argument `TraderDiagnosticThrottle` makes for keying per
 * kind.
 *
 * In memory and restart-clean, matching `TraderDiagnosticThrottle`: a fresh
 * process has no evidence about the previous one's alerts, and re-reporting a
 * genuinely carried lot once on restart is a feature.
 */
export class CarriedLotAlertThrottle {
  readonly #lastAlertAt = new Map<string, number>();

  shouldAlert(instrument: string, missedClose: Date, now: Date): boolean {
    const key = `${instrument}\0${missedClose.toISOString()}`;
    const last = this.#lastAlertAt.get(key);
    if (last !== undefined && now.getTime() - last < CARRIED_LOT_ALERT_REPEAT_MS) return false;
    this.#lastAlertAt.set(key, now.getTime());
    return true;
  }
}

export interface CarriedLotReporterDeps {
  clock: Clock;
  /**
   * The equity calendar — the SAME object the scheduler's grace tail and the
   * Trader's window resolve through (`equityCalendarFor`). A second calendar
   * here would be a second opinion about when the grace expired, and the two
   * disagreeing is how you get an alert for a lot that is still inside its
   * window, or silence for one that is not.
   */
  calendar: TradingCalendar;
  /** `TraderConfig.flatten_after_close_ms` — where the grace ends. */
  flattenAfterCloseMs: number;
  /**
   * This arm's open lots and its exit-fill record, bound to ONE store — the
   * held size in the alert is `filled_size` minus what is already closed, and
   * two stores would report a size the venue does not hold.
   */
  getOpenPositions: () => Promise<OpenPosition[]>;
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  logger: Logger;
  /** `trace_id` for this reporter's log lines — per arm, as #1321 requires. */
  traceId: string;
  /**
   * The audible copy. Optional for the reason `TraderDiagnosticAlertChannel`'s
   * own port doc gives: the `error` log below runs first and unconditionally,
   * so an absent channel means "no page", never "silent".
   */
  alerts?: TraderDiagnosticAlertChannel;
  throttle?: CarriedLotAlertThrottle;
}

/** One carried lot, as the alert reports it. */
interface CarriedLot {
  instrument: string;
  asset_class: OpenPosition['asset_class'];
  held: number;
  missedClose: Date;
}

/**
 * Groups this arm's open lots by instrument and returns those a session close
 * has passed over, with what the venue still holds.
 *
 * Exported for the test, and because the grouping is the substantive part: an
 * instrument can hold several lots and the operator needs ONE line naming the
 * total, not one per lot.
 */
export async function findCarriedLots(
  deps: Pick<
    CarriedLotReporterDeps,
    'calendar' | 'flattenAfterCloseMs' | 'getOpenPositions' | 'getExitFillSizes'
  >,
  now: Date,
): Promise<CarriedLot[]> {
  // Crypto never closes (`AlwaysOpenCalendar`, #667), so there is no close to
  // have been carried over and #1389 does not apply to it — the same answer
  // `withinFlattenWindow` and `postCloseFlattenTail` give.
  if (deps.calendar.sessionEnd(now) === null) return [];

  const missedClose = deps.calendar.sessionStart(now);
  // Still inside the grace: the flatten can and should still fire, and alerting
  // here would page for a window that is doing its job.
  if (now.getTime() - missedClose.getTime() <= deps.flattenAfterCloseMs) return [];

  const positions = await deps.getOpenPositions();
  const carried = positions.filter(
    (lot) => lot.asset_class === 'stocks' && lot.opened_at.getTime() < missedClose.getTime(),
  );
  if (carried.length === 0) return [];

  const held = await heldQuantitiesFor(carried, deps.getExitFillSizes);
  const heldByKey = new Map(held.map((lot) => [lot.idempotency_key, lot.held]));

  const byInstrument = new Map<string, CarriedLot>();
  for (const lot of carried) {
    const existing = byInstrument.get(lot.instrument);
    const quantity = heldByKey.get(lot.idempotency_key) ?? 0;
    if (existing === undefined) {
      byInstrument.set(lot.instrument, {
        instrument: lot.instrument,
        asset_class: lot.asset_class,
        held: quantity,
        missedClose,
      });
    } else {
      existing.held += quantity;
    }
  }

  // A lot whose exit fills already cover it is closed in substance and is
  // waiting on `ingestFills` to retire the row — reporting it as carried would
  // page an operator about a position that no longer exists at the venue.
  return [...byInstrument.values()].filter((lot) => lot.held > 0);
}

/**
 * The fill-sync hook: reports every carried lot once per repeat interval.
 *
 * Never throws. It is called from inside the poll, and a detector that could
 * take the fill loop down would cost the very `ingestFills` pass that retires
 * the lots it reports on.
 */
export function buildCarriedLotReporter(deps: CarriedLotReporterDeps): () => Promise<void> {
  const throttle = deps.throttle ?? new CarriedLotAlertThrottle();

  return async (): Promise<void> => {
    const now = deps.clock.now();
    let carried: CarriedLot[];
    try {
      carried = await findCarriedLots(deps, now);
    } catch (error) {
      deps.logger.log({
        trace_id: deps.traceId,
        stage: 'execution',
        event: 'carried_lot_check_failed',
        level: 'error',
        message: 'carried-lot check failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    for (const lot of carried) {
      if (!throttle.shouldAlert(lot.instrument, lot.missedClose, now)) continue;

      const diagnostic: TraderDiagnostic = {
        kind: 'lot_carried_past_session_close',
        asset_class: lot.asset_class,
        detail:
          `${lot.instrument}: ${lot.held} still held after the ${lot.missedClose.toISOString()} ` +
          `session close, past the ${deps.flattenAfterCloseMs}ms flatten grace ` +
          `(now ${now.toISOString()})`,
      };
      const alert: TraderDiagnosticAlert = {
        instrument: lot.instrument,
        diagnostic,
        // The unit here is a REPORT, not a tick — see the file docblock. One
        // alert per repeat interval, so the count would be a poll number that
        // means nothing to an operator; the interval is the severity signal.
        consecutive_ticks: 1,
        reported_at: now,
      };

      // Durable first, audible second — `TraderDiagnosticAlertChannel`'s port
      // doc, and the #710 correction that the log must not sit behind the
      // throttle that gates the channel.
      deps.logger.log({
        trace_id: deps.traceId,
        stage: 'execution',
        event: 'lot_carried_past_session_close',
        level: 'error',
        message: 'flat-by-close missed: lot carried past the session close',
        payload: {
          instrument: lot.instrument,
          held: lot.held,
          session_close: lot.missedClose.toISOString(),
        },
      });

      try {
        await deps.alerts?.postTraderDiagnosticAlert(alert);
      } catch (error) {
        deps.logger.log({
          trace_id: deps.traceId,
          stage: 'execution',
          event: 'carried_lot_alert_failed',
          level: 'error',
          message: 'carried-lot alert could not be delivered',
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  };
}
