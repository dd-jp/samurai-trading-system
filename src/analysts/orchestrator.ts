/**
 * Analyst Orchestrator (ticket #71) — see docs/specs/analysts-spec.md
 * "Module: Analyst Orchestrator". Fans a Signal out across every applicable
 * persona (Technical + Sentiment for crypto; Technical + Fundamental +
 * Sentiment for stocks, per `Analyst.applies_to`) and enforces the
 * role-dependent quorum: a mandatory persona failing blocks the whole tick
 * (analysts-spec.md story 21, "no stale fallback"), an optional persona
 * failing just shrinks the set (story 22).
 *
 * Retry-on-failure and the 2-consecutive-skip alert (analysts-spec.md
 * "Module: Failure Handling") are not built here — no ticket covers them
 * yet, so each persona gets a single attempt this tick.
 *
 * `analysts()` is the exact `TickSteps.analysts` shape (orchestrator/types.ts:
 * `(input: { trace_id, signal, clock }) => Promise<AnalystView[]>`), so an
 * instance can be bound directly into the tick chain once Market Data /
 * Market Intelligence instances exist at composition time. An empty array is
 * how the tick runner already recognizes a quorum skip (tick-runner.ts).
 */

import type { MarketDataService } from '../market-data-service/index.js';
import type { MarketIntelligenceStore } from '../market-intelligence/index.js';
import type { Clock } from '../shared/clock.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import { technicalAnalyst } from './technical-analyst.js';
import type { Analyst, AnalystFailure, AnalystRunResult, AnalystView, Signal } from './types.js';

const ALL_PERSONAS: Analyst[] = [technicalAnalyst, fundamentalAnalyst, sentimentAnalyst];

export interface AnalystOrchestratorDeps {
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
}

export class AnalystOrchestrator {
  constructor(
    private readonly deps: AnalystOrchestratorDeps,
    private readonly personas: Analyst[] = ALL_PERSONAS,
  ) {}

  /**
   * Runs every applicable persona in parallel and enforces the
   * role-dependent quorum. Returns the full breakdown (failures included)
   * for callers that need more than the bare view list.
   */
  async runAnalysts(trace_id: string, signal: Signal, clock: Clock): Promise<AnalystRunResult> {
    const applicable = this.personas.filter((persona) => persona.applies_to(signal.asset_class));
    const analyst_count = applicable.length;

    const outcomes = await Promise.all(
      applicable.map(async (persona) => {
        try {
          const view = await persona.run({
            trace_id,
            signal,
            clock,
            market_intelligence: this.deps.market_intelligence,
            market_data: this.deps.market_data,
          });
          return { persona, status: 'fulfilled' as const, view };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { persona, status: 'rejected' as const, reason };
        }
      }),
    );

    const views: AnalystView[] = [];
    const failures: AnalystFailure[] = [];
    let mandatoryFailed = false;

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        views.push(outcome.view);
        continue;
      }
      failures.push({
        analyst_type: outcome.persona.analyst_type,
        role: outcome.persona.role,
        reason: outcome.reason,
      });
      if (outcome.persona.role === 'mandatory') {
        mandatoryFailed = true;
      }
    }

    return {
      views: mandatoryFailed ? [] : views,
      analyst_count,
      skipped: mandatoryFailed,
      failures,
    };
  }

  /** The exact `TickSteps.analysts` shape (orchestrator/types.ts) — empty array = quorum skip. */
  async analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
  }): Promise<AnalystView[]> {
    const result = await this.runAnalysts(input.trace_id, input.signal, input.clock);
    return result.views;
  }
}
