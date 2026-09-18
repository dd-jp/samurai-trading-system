import type { AnalystTelemetry, IndicatorUnavailableEvent } from '../../pipeline/analysts/index.js';
import { INDICATOR_UNAVAILABLE_COUNTER } from '../../pipeline/analysts/index.js';
import type {
  FlattenOverfillAlertChannel,
  FlattenOverfillWarning,
} from '../../pipeline/execution/index.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
} from '../../pipeline/verdict/index.js';
import type { CiiScoreProvider } from '../../providers/market-intelligence/index.js';
import {
  MI_NO_DATA_BY_NAME_COUNTER,
  MI_NO_DATA_BY_SUBCLASS_COUNTER,
  type MiCoverageEvent,
  type MiCoverageTelemetry,
} from './production/mi-coverage.js';
import type { Logger } from './types.js';

export class LoggingFlattenOverfillAlertChannel implements FlattenOverfillAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void> {
    this.logger.log({
      trace_id: warning.trace_id,
      stage: 'execution',
      event: 'flatten_overfill_dropped',
      level: 'warn',
      message:
        "a flatten filled more than its named lots' journalled share — the excess was " +
        'dropped rather than guessed onto a lot; this should not happen under normal operation, ' +
        "so check the venue and the flatten's journal row by hand",
      payload: {
        idempotency_key: warning.idempotency_key,
        unattributed_qty: warning.unattributed_qty,
        observed_at: warning.observed_at.toISOString(),
      },
    });
  }
}

export class LoggingAnalystTelemetry implements AnalystTelemetry {
  constructor(private readonly logger: Logger) {}

  indicatorUnavailable(event: IndicatorUnavailableEvent): void {
    this.logger.log({
      trace_id: event.trace_id,
      stage: 'analysts',
      event: 'indicator_unavailable',
      level: 'warn',
      message:
        `${INDICATOR_UNAVAILABLE_COUNTER}{kind="${event.kind}"}: ${event.instrument} ` +
        `${event.axis} axis left the vote denominator — ${event.kind} needed ${event.required} ` +
        `bars, had ${event.received}`,
      payload: {
        counter: INDICATOR_UNAVAILABLE_COUNTER,
        analyst_type: event.analyst_type,
        instrument: event.instrument,
        axis: event.axis,
        kind: event.kind,
        required: event.required,
        received: event.received,
      },
    });
  }
}

export class LoggingMiCoverageTelemetry implements MiCoverageTelemetry {
  constructor(private readonly logger: Logger) {}

  noDataObserved(event: MiCoverageEvent): void {
    this.logger.log({
      trace_id: event.trace_id,
      stage: 'analysts',
      event: 'mi_no_data_observed',
      level: 'warn',
      message:
        `${MI_NO_DATA_BY_NAME_COUNTER}{instrument="${event.instrument}"} ` +
        `${MI_NO_DATA_BY_SUBCLASS_COUNTER}{subclass="${event.subclass}"}: ${event.instrument} ` +
        `has no scored market-intelligence item inside the staleness window`,
      payload: {
        counter_by_name: MI_NO_DATA_BY_NAME_COUNTER,
        counter_by_subclass: MI_NO_DATA_BY_SUBCLASS_COUNTER,
        instrument: event.instrument,
        asset_class: event.asset_class,
        subclass: event.subclass,
      },
    });
  }
}

export class UnwiredApprovalChannel implements ApprovalChannel {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    throw new Error(
      "Verdict's HITL gate (6) was reached, but no ApprovalChannel is wired. Since ADR-0007 the " +
        'automation dial is `auto` for both asset classes, under which this gate is ' +
        'unreachable — so reaching it means `verdictConfig.automation_level` was set to ' +
        '`manual` or `semi_auto` without also supplying `ProductionConfig.approvals`. Either ' +
        'set the dial back to `auto`, or build and wire a real channel — none exists in the ' +
        'repo since the Telegram approval half was retired (ADR-0007, ADR-0013). Refusing ' +
        'rather than ' +
        `auto-approving: trace ${request.trace_id}, ` +
        `${request.order_intent.side} ${request.order_intent.size} ` +
        `${request.order_intent.instrument}.`,
    );
  }
}

export class ParkedCiiScoreProvider implements CiiScoreProvider {
  async getCii(): Promise<number | null> {
    return null;
  }
}
