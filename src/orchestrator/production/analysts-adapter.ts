/**
 * Production Composition Root: Analysts adapter (ticket #235). See
 * ADR-0004 §3, docs/specs/orchestrator-spec.md ("Module: Production
 * Composition Root"), closed wayfinder map #224.
 *
 * `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` takes three
 * positional arguments and returns `AnalystRunResult` (`{ views,
 * analyst_count, skipped, failures }`); `TickSteps.analysts` takes one object
 * (`{ trace_id, signal, clock }`) and returns bare `AnalystView[]`. This
 * adapter only narrows the call/return shape — it does not change
 * `AnalystOrchestrator`'s applicability filtering or quorum logic (#235 AC).
 * An empty view array is exactly `runAnalysts`'s `skipped` case, preserving
 * the existing quorum-skip contract `SequentialTickRunner` short-circuits on.
 *
 * **Failures are logged here (issue #358 item 4).** Narrowing to `views` used
 * to drop `failures` on the floor, and that drop is why a total market-data
 * outage — every crypto request 404ing against a wrong API version — looked
 * like a quiet decision for a whole paper run. `SequentialTickRunner` sees only
 * the view array, so it logs `analysts: quorum_skip` at `info` with an empty
 * payload; the only place the reasons still exist is right here, between
 * `runAnalysts` returning and the narrowing throwing them away. So this is
 * where they get emitted, on the same `trace_id` the tick's own lines carry.
 *
 * Level splits on `role`, because the two cases are operationally different:
 * a mandatory persona failing HALTED trading for this instrument (`error`); an
 * optional one failing only shrank the debate panel and the tick continued
 * (`warn`). Both are logged even though only the first is a skip — an optional
 * analyst that has been failing silently for a week is worth seeing too.
 */
import type { AnalystOrchestrator } from '../../analysts/index.js';
import type { Logger } from '../../shared/index.js';
import type { TickSteps } from '../types.js';

export function buildAnalystsStep(
  orchestrator: AnalystOrchestrator,
  logger?: Logger,
): TickSteps['analysts'] {
  return async ({ trace_id, signal, clock }) => {
    const result = await orchestrator.runAnalysts(trace_id, signal, clock);

    if (logger !== undefined && result.failures.length > 0) {
      const mandatoryFailed = result.failures.some((failure) => failure.role === 'mandatory');
      const detail = result.failures
        .map((failure) => `${failure.analyst_type} (${failure.role}): ${failure.reason}`)
        .join('; ');
      logger.log({
        trace_id,
        stage: 'analysts',
        level: mandatoryFailed ? 'error' : 'warn',
        message: mandatoryFailed
          ? `analysts: ${signal.asset} quorum NOT met — mandatory analyst failed, no trade is ` +
            `possible this tick: ${detail}`
          : `analysts: ${signal.asset} optional analyst failed, tick continues on a smaller ` +
            `panel: ${detail}`,
        payload: { instrument: signal.asset, failures: result.failures },
      });
    }

    return result.views;
  };
}
