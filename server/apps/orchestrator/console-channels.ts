/**
 * Log-stream stand-ins that are NOT alerts, and so have no catalogue entry
 * (alert-catalogue.ts): two telemetry counters whose log line IS the metric
 * store, one diagnostic trail with no phone-reaching counterpart, and two
 * deliberately inert providers. The operator alerts' log-only forms are
 * `loggingAlertChannel(id, logger)`.
 */

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

/**
 * A flatten fill that filled more than its named lots' journalled share
 * (#527), written to the log at `warn`. See `FlattenOverfillAlertChannel`'s
 * doc (execution/flatten-overfill-alert.ts) for why this is a diagnostic
 * trail rather than an operator escalation: the redistribution that reports
 * it still completes, and the excess is dropped either way — this only makes
 * the drop visible instead of silent.
 *
 * No phone-reaching counterpart (yet) — the same posture
 * `ResidualExposureAlertChannel` had before #551 wired it through
 * `SAMURAI_ALERTS`. This condition is "should never happen" rather than an
 * unattended-soak emergency, so a log line an operator can grep after the
 * fact is the right first step; paging on it is a later ticket if it ever
 * actually fires.
 */
export class LoggingFlattenOverfillAlertChannel implements FlattenOverfillAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void> {
    this.logger.log({
      // Threaded from the warning, not fixed here (#1348) — the live and
      // control arms post through this SAME instance, so the id of the surface
      // `ingestFills()` ran on is the only thing in the line that tells a
      // real venue's drop from a simulated broker's. See
      // `FlattenOverfillWarning.trace_id`.
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

/**
 * `technical_indicator_unavailable{kind}` (#745), written to the log stream.
 *
 * This is a COUNTER, not an alert, and the level says so: an enrichment axis
 * short of bars is the designed degradation — the technical analyst is
 * `mandatory`, and the whole point of the core/enrichment split is that a cold
 * or thin instrument still produces a usable view instead of forfeiting the
 * tick as a `quorum_skip`. So `warn`, not `error`: worth counting, never worth
 * paging. A `debug` would be worse — the operational question this exists to
 * answer is "how much of the axis panel has this instrument actually been
 * voting on", and a level nobody ships cannot answer it.
 *
 * There is no metrics registry in this system; the log stream IS the metric
 * store (`rotating-file-sink.ts`), so the counter name is emitted as a field
 * rather than incremented in a gauge, and a scrape aggregates by
 * `payload.counter` + `payload.kind`. Named from
 * `INDICATOR_UNAVAILABLE_COUNTER` so the sink and any future scrape cannot
 * drift apart on spelling.
 */
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

/**
 * `mi_no_data_by_name{instrument}` / `mi_no_data_by_subclass{subclass}` (#752),
 * written to the log stream — same convention as `LoggingAnalystTelemetry`:
 * the log IS the metric store, and a scrape aggregates by `payload.counter`.
 * Fires only on a miss; a rate is the scrape's job, dividing by the tick
 * count recorded elsewhere.
 */
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

/**
 * The composition root's default `ApprovalChannel` since ADR-0007 made
 * `automation_level` fully `auto` — and it exists to be **unreachable**.
 *
 * Under `auto`, `shouldEngageHitl` short-circuits to `false` before the
 * HITL gate (6), so `requestApproval` is never called and no approval
 * transport is needed in any mode. That is why this class does not refuse to
 * be constructed in `live`, unlike an auto-approving stand-in: refusing there
 * would block a live start over a gate that never fires.
 *
 * What it will not do is silently stand in for a human if the dial is ever
 * moved off `auto` — that would be a code change (async-approval semantics,
 * verdict-spec.md's "Problem Statement"; #434, closed, reached the same
 * conclusion), not a config edit. An auto-approving default is safe only
 * while nothing real depends on the answer; the moment `manual` or
 * `semi_auto` is set with no transport wired, auto-approving means the gate
 * reads as enforced and enforces nothing — this repo's dominant defect
 * class. No human gate exists anywhere in paper or live for an
 * auto-approving stand-in to serve, so this one throws instead of
 * fabricating consent. The throw propagates out of `VerdictImpl.decide` and
 * fails that instrument's pass loudly rather than silently answering on the
 * gate's behalf.
 */
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

/**
 * The parked WorldMonitor CII feed (ADR-0002): always "no score".
 *
 * Not a stub standing in for something that should be here — the live
 * WorldMonitor wiring is deliberately parked for the duration of paper
 * trading, because it costs money per call and the geopolitical tier is not
 * what the first paper run is testing. `CiiScoreProvider.getCii` already has
 * `null` in its contract for "WorldMonitor has no score for this country", and
 * `CiiConsumer` already handles that path, so this provider exercises a route
 * the system supports rather than one it has to be taught.
 *
 * Silent by design: unlike the approval channel, returning `null` here is a
 * documented, expected answer rather than a fabricated consent, so logging it
 * once per country per poll would be noise on a path that is behaving
 * correctly.
 */
export class ParkedCiiScoreProvider implements CiiScoreProvider {
  async getCii(): Promise<number | null> {
    return null;
  }
}
