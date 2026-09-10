/**
 * #1389's residual failure mode, made audible.
 *
 * Extending the flatten window past the bell makes the silent overnight carry
 * RARER, not impossible: a pass saturated through the whole window and the
 * whole grace, or a process down across both, still leaves a lot open. ADR-0014
 * calls flat-by-close "an invariant with no exception case", so the leftover has
 * to page rather than merely be less likely — and nothing in the tick path can
 * do the paging, because the condition being detected is precisely the one where
 * the tick path has already stopped for the day.
 *
 * Asserted against the REAL `LseRegularHoursCalendar`: the question is whether
 * the grace a conforming calendar implies has actually expired, and a stub would
 * answer whatever it was handed.
 */
import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { OpenPosition, TradingArm } from '../../../shared/index.js';
import { formatTraderDiagnosticAlert } from '../trader-diagnostic-alert-channel.js';
import type { LogEntry, Logger } from '../types.js';
import {
  buildCarriedLotReporter,
  CARRIED_LOT_ALERT_REPEAT_MS,
  CarriedLotAlertThrottle,
  findCarriedLots,
} from './carried-lot-alert.js';
import type { TraderDiagnosticAlert } from './trader-diagnostic-alert.js';

/** `DEFAULT_TRADER_CONFIG.flatten_after_close_ms`. */
const GRACE_MS = 5 * 60 * 1_000;

/** A Wednesday inside British Summer Time. LSE close 16:30 London. */
const CLOSE = new Date('2026-08-19T16:30:00+01:00');
const INSIDE_GRACE = new Date('2026-08-19T16:33:00+01:00');
const PAST_GRACE = new Date('2026-08-19T16:40:00+01:00');
/** The next morning, market open — a carried lot is still carried (#1389: alert, do not pre-open flatten). */
const NEXT_MORNING = new Date('2026-08-20T09:00:00+01:00');

function lot(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: '3USL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 12,
    filled_size: 12,
    avg_entry_price: 30,
    stop: 28,
    target: 34,
    order_state: 'filled',
    broker_order_ids: ['b-1'],
    // Mid-session, comfortably before the close it then failed to clear.
    opened_at: new Date('2026-08-19T14:00:00+01:00'),
    decision_timestamp: new Date('2026-08-19T14:00:00+01:00'),
    conviction: 0.8,
    converged: true,
    ...overrides,
  };
}

function collectingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

const NO_EXIT_FILLS = async (): Promise<Map<string, number>> => new Map<string, number>();

function deps(options: {
  positions: OpenPosition[];
  now: Date;
  exitFills?: () => Promise<Map<string, number>>;
  logger?: Logger;
  alerts?: { postTraderDiagnosticAlert: (alert: TraderDiagnosticAlert) => Promise<void> };
  throttle?: CarriedLotAlertThrottle;
  calendar?: LseRegularHoursCalendar | AlwaysOpenCalendar;
  arm?: TradingArm;
}) {
  return {
    clock: { now: () => options.now },
    calendar: options.calendar ?? new LseRegularHoursCalendar(),
    flattenAfterCloseMs: GRACE_MS,
    getOpenPositions: async () => options.positions,
    getExitFillSizes: options.exitFills ?? NO_EXIT_FILLS,
    logger: options.logger ?? { log: () => {} },
    traceId: 'trace-carried',
    arm: options.arm ?? 'live',
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  };
}

describe('findCarriedLots', () => {
  it('reports a lot still open once the grace has expired, with the size the venue holds', async () => {
    const carried = await findCarriedLots(
      deps({ positions: [lot()], now: PAST_GRACE }),
      PAST_GRACE,
    );

    expect(carried).toHaveLength(1);
    expect(carried[0]?.instrument).toBe('3USL');
    expect(carried[0]?.held).toBe(12);
    expect(carried[0]?.missedClose.toISOString()).toBe(CLOSE.toISOString());
  });

  it('stays silent while the flatten grace is still running', async () => {
    // The window is doing its job at this instant: the Trader can and should
    // still flatten. Paging here would report the mechanism as the failure.
    expect(
      await findCarriedLots(deps({ positions: [lot()], now: INSIDE_GRACE }), INSIDE_GRACE),
    ).toEqual([]);
  });

  it('keeps reporting the next morning — a carried lot is alerted, never pre-open flattened', async () => {
    // #1389 rules that a lot found carried at the next open is ALERTED and left
    // alone: trading into an opening auction is a real-money decision David has
    // not made. So this must not go quiet just because the venue reopened.
    const carried = await findCarriedLots(
      deps({ positions: [lot()], now: NEXT_MORNING }),
      NEXT_MORNING,
    );

    expect(carried).toHaveLength(1);
    // ...and it names the close that was MISSED, which by now is yesterday's.
    expect(carried[0]?.missedClose.toISOString()).toBe(CLOSE.toISOString());
  });

  it('ignores a lot opened after the close it is being measured against', async () => {
    // A lot opened at 16:35 on the same evening (a fill landing late, say) has
    // not been carried over anything yet — its first close is tomorrow's.
    const late = lot({ opened_at: new Date('2026-08-19T16:35:00+01:00') });

    expect(await findCarriedLots(deps({ positions: [late], now: PAST_GRACE }), PAST_GRACE)).toEqual(
      [],
    );
  });

  it('sums the lots of one instrument into a single line', async () => {
    // An operator needs ONE number to compare against the venue, not one line
    // per lot to add up under time pressure.
    const carried = await findCarriedLots(
      deps({
        positions: [lot(), lot({ idempotency_key: 'key-2', filled_size: 5 })],
        now: PAST_GRACE,
      }),
      PAST_GRACE,
    );

    expect(carried).toHaveLength(1);
    expect(carried[0]?.held).toBe(17);
  });

  it('nets exit fills out, so a lot waiting on ingestFills does not page', async () => {
    // The exits filled; only the `open_positions` row is left, and `ingestFills`
    // retires it on its own cadence. Reporting that as a carried position sends
    // an operator to the venue to find nothing there.
    const exitFills = async (): Promise<Map<string, number>> => new Map([['key-1', 12]]);

    expect(
      await findCarriedLots(deps({ positions: [lot()], now: PAST_GRACE, exitFills }), PAST_GRACE),
    ).toEqual([]);
  });

  it('is silent on a venue that never closes — there is no close to have carried over (#667)', async () => {
    const crypto = lot({ instrument: 'BTC-USD', asset_class: 'crypto' });

    expect(
      await findCarriedLots(
        deps({ positions: [crypto], now: PAST_GRACE, calendar: new AlwaysOpenCalendar() }),
        PAST_GRACE,
      ),
    ).toEqual([]);
  });

  it('ignores a crypto lot even on an equity calendar', async () => {
    // The arm's store holds whatever the arm traded. Flat-by-close is ADR-0014's
    // equity invariant and must not be enforced against a class it never covered.
    const crypto = lot({ instrument: 'BTC-USD', asset_class: 'crypto' });

    expect(
      await findCarriedLots(deps({ positions: [crypto], now: PAST_GRACE }), PAST_GRACE),
    ).toEqual([]);
  });
});

describe('buildCarriedLotReporter', () => {
  it('logs at error and alerts once, naming the instrument and the held size', async () => {
    const { logger, entries } = collectingLogger();
    const posted: TraderDiagnosticAlert[] = [];
    const report = buildCarriedLotReporter(
      deps({
        positions: [lot()],
        now: PAST_GRACE,
        logger,
        alerts: {
          postTraderDiagnosticAlert: async (alert) => {
            posted.push(alert);
          },
        },
      }),
    );

    await report();

    const lines = entries.filter((entry) => entry.event === 'lot_carried_past_session_close');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.trace_id).toBe('trace-carried');
    expect(lines[0]?.payload).toMatchObject({ instrument: '3USL', arm: 'live', held: 12 });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.instrument).toBe('3USL');
    expect(posted[0]?.diagnostic.kind).toBe('lot_carried_past_session_close');
    // The two facts an operator acts on: which name, and how much of it.
    expect(posted[0]?.diagnostic.detail).toContain('3USL');
    expect(posted[0]?.diagnostic.detail).toContain('12');
  });

  it("carries the reporter's own arm on the alert, so a live and a control lot on the same instrument do not render identically", async () => {
    const liveArm: TraderDiagnosticAlert[] = [];
    const controlArm: TraderDiagnosticAlert[] = [];

    await buildCarriedLotReporter(
      deps({
        positions: [lot()],
        now: PAST_GRACE,
        arm: 'live',
        alerts: { postTraderDiagnosticAlert: async (alert) => void liveArm.push(alert) },
      }),
    )();
    await buildCarriedLotReporter(
      deps({
        positions: [lot()],
        now: PAST_GRACE,
        arm: 'control',
        alerts: { postTraderDiagnosticAlert: async (alert) => void controlArm.push(alert) },
      }),
    )();

    expect(liveArm[0]?.arm).toBe('live');
    expect(controlArm[0]?.arm).toBe('control');
    // Both fire for the SAME instrument at the SAME instant — everything but
    // `arm` is identical, which is exactly the pair that used to page twice
    // with indistinguishable text.
    expect(liveArm[0]?.instrument).toBe(controlArm[0]?.instrument);
    expect(formatTraderDiagnosticAlert(liveArm[0] as TraderDiagnosticAlert)).not.toBe(
      formatTraderDiagnosticAlert(controlArm[0] as TraderDiagnosticAlert),
    );
  });

  it('does not re-alert on every 15s poll while the lot stays open', async () => {
    // The detector runs on the fill-sync loop, which polls every 15 seconds.
    // Unthrottled, one carried lot would post ~240 messages an hour into the
    // channel that also carries kill-threshold breaches — the flood ADR-0008 §1
    // refuses. Driven at a real poll cadence rather than by calling twice at the
    // same instant, so a throttle keyed on equality alone would not pass.
    const posted: TraderDiagnosticAlert[] = [];
    const alerts = {
      postTraderDiagnosticAlert: async (alert: TraderDiagnosticAlert) => {
        posted.push(alert);
      },
    };
    const throttle = new CarriedLotAlertThrottle();
    let now = PAST_GRACE;

    for (let poll = 0; poll < 40; poll += 1) {
      await buildCarriedLotReporter(deps({ positions: [lot()], now, alerts, throttle }))();
      now = new Date(now.getTime() + 15_000);
    }

    expect(posted).toHaveLength(1);
  });

  it('re-alerts once the repeat interval has passed, so a long carry is not forgotten', async () => {
    const posted: TraderDiagnosticAlert[] = [];
    const alerts = {
      postTraderDiagnosticAlert: async (alert: TraderDiagnosticAlert) => {
        posted.push(alert);
      },
    };
    const throttle = new CarriedLotAlertThrottle();
    const later = new Date(PAST_GRACE.getTime() + CARRIED_LOT_ALERT_REPEAT_MS);

    await buildCarriedLotReporter(
      deps({ positions: [lot()], now: PAST_GRACE, alerts, throttle }),
    )();
    await buildCarriedLotReporter(deps({ positions: [lot()], now: later, alerts, throttle }))();

    expect(posted).toHaveLength(2);
  });

  it('re-alerts immediately when a SECOND close is missed, without waiting out the interval', async () => {
    // Keyed per (instrument, missed close): a lot carried across two sessions is
    // a materially worse condition than one carried across one, and it must not
    // be swallowed by a repeat interval started against the first.
    const posted: TraderDiagnosticAlert[] = [];
    const alerts = {
      postTraderDiagnosticAlert: async (alert: TraderDiagnosticAlert) => {
        posted.push(alert);
      },
    };
    const throttle = new CarriedLotAlertThrottle();
    const nextEvening = new Date('2026-08-20T16:40:00+01:00');

    await buildCarriedLotReporter(
      deps({ positions: [lot()], now: PAST_GRACE, alerts, throttle }),
    )();
    await buildCarriedLotReporter(
      deps({ positions: [lot()], now: nextEvening, alerts, throttle }),
    )();

    expect(posted).toHaveLength(2);
    expect(posted[1]?.diagnostic.detail).toContain('2026-08-20T15:30:00.000Z');
  });

  it('still logs with no channel wired — an absent channel means no page, never silence', async () => {
    const { logger, entries } = collectingLogger();

    await buildCarriedLotReporter(deps({ positions: [lot()], now: PAST_GRACE, logger }))();

    expect(
      entries.filter((entry) => entry.event === 'lot_carried_past_session_close'),
    ).toHaveLength(1);
  });

  it('never throws out of the poll, even when the store fails', async () => {
    // It is called from inside `runPoll`. A detector that could take the fill
    // loop down would cost the very `ingestFills` pass that retires the lots it
    // reports on — the failure would delete its own remedy.
    const { logger, entries } = collectingLogger();
    const report = buildCarriedLotReporter({
      ...deps({ positions: [], now: PAST_GRACE, logger }),
      getOpenPositions: async () => {
        throw new Error('store unavailable');
      },
    });

    await expect(report()).resolves.toBeUndefined();
    expect(entries.some((entry) => entry.event === 'carried_lot_check_failed')).toBe(true);
  });

  it('survives an alert transport that rejects, and says so durably', async () => {
    const { logger, entries } = collectingLogger();
    const report = buildCarriedLotReporter(
      deps({
        positions: [lot()],
        now: PAST_GRACE,
        logger,
        alerts: {
          postTraderDiagnosticAlert: async () => {
            throw new Error('telegram down');
          },
        },
      }),
    );

    await expect(report()).resolves.toBeUndefined();
    // The durable record is written BEFORE the transport is tried, so it
    // survives the transport failing.
    expect(
      entries.filter((entry) => entry.event === 'lot_carried_past_session_close'),
    ).toHaveLength(1);
    expect(entries.some((entry) => entry.event === 'carried_lot_alert_failed')).toBe(true);
  });
});
