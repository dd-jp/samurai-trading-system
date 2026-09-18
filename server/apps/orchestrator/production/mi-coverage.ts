import type { MarketContext } from '../../../providers/market-intelligence/index.js';
import { resolveMiSubject } from '../../../providers/universe-pool/index.js';
import type { AssetClass, InstrumentSubclass, Logger } from '../../../shared/index.js';
import { describeThrownSafely, escalatesAt } from '../../../shared/index.js';

export const UNCLASSIFIED_SUBCLASS = 'unclassified' as const;

export type CoverageSubclass = InstrumentSubclass | typeof UNCLASSIFIED_SUBCLASS;

export function subclassFor(
  instrument: string,
  subclassOf: Readonly<Record<string, InstrumentSubclass>>,
): CoverageSubclass {
  return subclassOf[instrument] ?? UNCLASSIFIED_SUBCLASS;
}

const COVERAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MI_NO_DATA_BY_NAME_COUNTER = 'mi_no_data_by_name';
export const MI_NO_DATA_BY_SUBCLASS_COUNTER = 'mi_no_data_by_subclass';

export interface MiCoverageEvent {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  subclass: CoverageSubclass;
  reported_at: Date;
}

export interface MiCoverageTelemetry {
  noDataObserved(event: MiCoverageEvent): void;
}

export interface MiCoverageAlert {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  subclass: CoverageSubclass;
  reported_at: Date;
}

export interface MiCoverageAlertChannel {
  postCoverageAlert(alert: MiCoverageAlert): Promise<void>;
}

export interface MiCoverageContextSource {
  getContext(assetClass: AssetClass, timeWindowMs: number, trace_id: string): MarketContext;
}

export function hasCoverageFor(context: MarketContext, instrument: string): boolean {
  return (
    context.news.some((item) => item.entity === instrument) ||
    context.social.some((item) => item.entity === instrument)
  );
}

const ALERT_AFTER_CONSECUTIVE_NO_DATA = 1;

const ALERT_REPEAT_EVERY_NO_DATA = 8;

const NO_DATA_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_NO_DATA,
  every: ALERT_REPEAT_EVERY_NO_DATA,
};

function shouldAlertAt(consecutive: number): boolean {
  return escalatesAt(consecutive, NO_DATA_CADENCE);
}

export class MiCoverageMonitor {
  readonly #consecutive = new Map<string, number>();
  readonly #currentlyMissing = new Set<string>();
  #everDegraded = false;

  get degraded(): boolean {
    return this.#currentlyMissing.size > 0;
  }

  get everDegraded(): boolean {
    return this.#everDegraded;
  }

  get missingInstruments(): readonly string[] {
    return Array.from(this.#currentlyMissing);
  }

  observe(instrument: string, covered: boolean): { alert: boolean; consecutive: number } {
    if (covered) {
      this.#consecutive.delete(instrument);
      this.#currentlyMissing.delete(instrument);
      return { alert: false, consecutive: 0 };
    }

    const consecutive = (this.#consecutive.get(instrument) ?? 0) + 1;
    this.#consecutive.set(instrument, consecutive);
    this.#currentlyMissing.add(instrument);
    this.#everDegraded = true;
    return { alert: shouldAlertAt(consecutive), consecutive };
  }
}

export interface CheckMiCoverageDeps {
  contextSource: MiCoverageContextSource;
  subclassOf: Readonly<Record<string, InstrumentSubclass>>;
  telemetry: MiCoverageTelemetry;
  monitor: MiCoverageMonitor;
  alertChannel: MiCoverageAlertChannel | undefined;
  logger: Logger | undefined;
  refreshAttempted?: ((instrument: string) => boolean) | undefined;
}

export interface CheckMiCoverageParams {
  trace_id: string;
  instrument: string;
  assetClass: AssetClass;
  reportedAt: Date;
}

export async function checkMiCoverage(
  deps: CheckMiCoverageDeps,
  params: CheckMiCoverageParams,
): Promise<void> {
  const context = deps.contextSource.getContext(
    params.assetClass,
    COVERAGE_WINDOW_MS,
    params.trace_id,
  );
  const covered = hasCoverageFor(context, resolveMiSubject(params.instrument));
  const subclass = subclassFor(params.instrument, deps.subclassOf);

  if (!covered) {
    deps.telemetry.noDataObserved({
      trace_id: params.trace_id,
      instrument: params.instrument,
      asset_class: params.assetClass,
      subclass,
      reported_at: params.reportedAt,
    });
  }

  if (deps.refreshAttempted?.(params.instrument) === false) return;

  const { alert } = deps.monitor.observe(params.instrument, covered);
  if (!alert) return;

  try {
    await deps.alertChannel?.postCoverageAlert({
      trace_id: params.trace_id,
      instrument: params.instrument,
      asset_class: params.assetClass,
      subclass,
      reported_at: params.reportedAt,
    });
  } catch (error) {
    deps.logger?.log({
      trace_id: params.trace_id,
      stage: 'analysts',
      event: 'mi_coverage_alert_send_failed',
      level: 'error',
      message:
        `market-intelligence coverage alert could not be delivered for ${params.instrument} — ` +
        'coverage is still missing and nobody has been told',
      payload: {
        instrument: params.instrument,
        subclass,
        error: describeThrownSafely(error),
      },
    });
  }
}
