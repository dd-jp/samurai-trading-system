import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';
import type { Clock, OpenPosition, TradingArm } from '../../../shared/index.js';
import { heldQuantitiesFor } from '../../../shared/index.js';
import type { Logger } from '../types.js';
import type {
  TraderDiagnosticAlert,
  TraderDiagnosticAlertChannel,
} from './trader-diagnostic-alert.js';

export const CARRIED_LOT_ALERT_REPEAT_MS = 2 * 60 * 60 * 1_000;

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
  arm: TradingArm;
  calendar: TradingCalendar;
  flattenAfterCloseMs: number;
  getOpenPositions: () => Promise<OpenPosition[]>;
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  logger: Logger;
  traceId: string;
  alerts?: TraderDiagnosticAlertChannel;
  throttle?: CarriedLotAlertThrottle;
}

interface CarriedLot {
  instrument: string;
  asset_class: OpenPosition['asset_class'];
  held: number;
  missedClose: Date;
}

export async function findCarriedLots(
  deps: Pick<
    CarriedLotReporterDeps,
    'calendar' | 'flattenAfterCloseMs' | 'getOpenPositions' | 'getExitFillSizes'
  >,
  now: Date,
): Promise<CarriedLot[]> {
  if (deps.calendar.sessionEnd(now) === null) return [];

  const missedClose = deps.calendar.sessionStart(now);
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

  return [...byInstrument.values()].filter((lot) => lot.held > 0);
}

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
      await reportCarriedLot(deps, lot, now);
    }
  };
}

async function reportCarriedLot(
  deps: Pick<
    CarriedLotReporterDeps,
    'traceId' | 'logger' | 'arm' | 'alerts' | 'flattenAfterCloseMs'
  >,
  lot: CarriedLot,
  now: Date,
): Promise<void> {
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
    arm: deps.arm,
    consecutive_ticks: 1,
    reported_at: now,
  };

  deps.logger.log({
    trace_id: deps.traceId,
    stage: 'execution',
    event: 'lot_carried_past_session_close',
    level: 'error',
    message: 'flat-by-close missed: lot carried past the session close',
    payload: {
      instrument: lot.instrument,
      arm: deps.arm,
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
