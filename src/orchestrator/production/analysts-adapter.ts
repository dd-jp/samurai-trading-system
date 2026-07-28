/**
 * Production Composition Root: Analysts adapter (ticket #235). See
 * ADR-0004 §3, docs/specs/orchestrator-spec.md ("Module: Production
 * Composition Root"), closed wayfinder map #224.
 *
 * `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` takes three
 * positional arguments and returns `AnalystRunResult` (`{ views,
 * analyst_count, skipped }`); `TickSteps.analysts` takes one object
 * (`{ trace_id, signal, clock }`) and returns bare `AnalystView[]`. This
 * adapter only narrows the call/return shape — it does not change
 * `AnalystOrchestrator`'s applicability filtering or quorum logic (#235 AC).
 * An empty view array is exactly `runAnalysts`'s `skipped` case, preserving
 * the existing quorum-skip contract `SequentialTickRunner` short-circuits on.
 */
import type { AnalystOrchestrator } from '../../analysts/index.js';
import type { TickSteps } from '../types.js';

export function buildAnalystsStep(orchestrator: AnalystOrchestrator): TickSteps['analysts'] {
  return async ({ trace_id, signal, clock }) => {
    const result = await orchestrator.runAnalysts(trace_id, signal, clock);
    return result.views;
  };
}
