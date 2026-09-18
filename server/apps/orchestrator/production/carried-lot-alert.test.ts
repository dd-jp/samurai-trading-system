import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { OpenPosition, TradingArm } from '../../../shared/index.js';
import { ALERT_CATALOGUE } from '../alert-catalogue.js';
import type { LogEntry, Logger } from '../types.js';
import {
  buildCarriedLotReporter,
  CARRIED_LOT_ALERT_REPEAT_MS,
  CarriedLotAlertThrottle,
  findCarriedLots,
} from './carried-lot-alert.js';
import type { TraderDiagnosticAlert } from './trader-diagnostic-alert.js';

const GRACE_MS = 5 * 60 * 1_000;

const CLOSE = new Date('2026-08-19T16:30:00+01:00');
const INSIDE_GRACE = new Date('2026-08-19T16:33:00+01:00');
const PAST_GRACE = new Date('2026-08-19T16:40:00+01:00');
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
    expect(
      await findCarriedLots(deps({ positions: [lot()], now: INSIDE_GRACE }), INSIDE_GRACE),
    ).toEqual([]);
  });

  it('keeps reporting the next morning — a carried lot is alerted, never pre-open flattened', async () => {
    const carried = await findCarriedLots(
      deps({ positions: [lot()], now: NEXT_MORNING }),
      NEXT_MORNING,
    );

    expect(carried).toHaveLength(1);
    expect(carried[0]?.missedClose.toISOString()).toBe(CLOSE.toISOString());
  });

  it('ignores a lot opened after the close it is being measured against', async () => {
    const late = lot({ opened_at: new Date('2026-08-19T16:35:00+01:00') });

    expect(await findCarriedLots(deps({ positions: [late], now: PAST_GRACE }), PAST_GRACE)).toEqual(
      [],
    );
  });

  it('sums the lots of one instrument into a single line', async () => {
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
    expect(liveArm[0]?.instrument).toBe(controlArm[0]?.instrument);
    expect(
      ALERT_CATALOGUE.traderDiagnosticAlerts.text(liveArm[0] as TraderDiagnosticAlert),
    ).not.toBe(ALERT_CATALOGUE.traderDiagnosticAlerts.text(controlArm[0] as TraderDiagnosticAlert));
  });

  it('does not re-alert on every 15s poll while the lot stays open', async () => {
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
    expect(
      entries.filter((entry) => entry.event === 'lot_carried_past_session_close'),
    ).toHaveLength(1);
    expect(entries.some((entry) => entry.event === 'carried_lot_alert_failed')).toBe(true);
  });
});
