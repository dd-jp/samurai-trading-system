/**
 * Tick loop (ticket #94) — fans a TickPlan out across instruments under a
 * concurrency cap. See docs/specs/orchestrator-spec.md (Module: Tick Runner,
 * Module: Determinism & Backtest) and docs/wayfinder/orchestrator-map.md
 * ("bounded parallelism, not fully sequential").
 *
 * The cap protects the LLM rate limit shared by Analysts/Debate (CLAUDE.md's
 * HARD STOP governs those, not Execution's broker calls). It bounds how many
 * instruments run their pipelines concurrently — never any single
 * instrument's internal latency budget, which the Debate Engine owns.
 *
 * `max_concurrent_instruments: 1` is the sequential mode walk-forward replay
 * needs: outcomes come back in plan order regardless of the cap, but a cap of
 * 1 also makes the interleaving of stage calls across instruments
 * deterministic.
 *
 * Each worker's `runner.runInstrument` call is wrapped in its own try/catch
 * (#507): one instrument throwing must fail only that instrument, not reject
 * this worker's `Promise.all` entry and settle the whole tick early while
 * sibling workers are still mid-pipeline (and still billing LLM debates). See
 * the `worker()` function below and `TickOutcome.error`.
 */
import { randomUUID } from 'node:crypto';
import type { Signal } from '../analysts/index.js';
import type { Clock } from '../shared/index.js';
import type {
  AuditLog,
  CurrentTickStore,
  Logger,
  TickOutcome,
  TickPlan,
  TickRunner,
} from './types.js';

export interface TickLoopConfig {
  /** Simultaneous instrument passes. Values < 1 are clamped to 1. */
  max_concurrent_instruments: number;
  /**
   * Trace-ID source, generated per instrument at Signal emission
   * (orchestrator-spec.md story 9). Injected rather than called directly so
   * replay can supply a deterministic sequence — the determinism story needs
   * byte-identical outcomes across two runs, which random UUIDs cannot give.
   */
  newTraceId?: () => string;
  /** Shared structured-logging interface, forwarded into every instrument's TickContext (#95). */
  logger: Logger;
  /** shared_store.audit_log writer, forwarded into every instrument's TickContext (#95). */
  auditLog: AuditLog;
  /** shared_store.current_tick writer, forwarded into every instrument's TickContext (#96). */
  currentTickStore: CurrentTickStore;
}

/**
 * Runs every instrument in `plan`, at most `max_concurrent_instruments` at a
 * time. Outcomes are returned in plan order, not completion order.
 */
export async function runTickPlan(
  plan: TickPlan,
  runner: TickRunner,
  clock: Clock,
  config: TickLoopConfig,
): Promise<TickOutcome[]> {
  const newTraceId = config.newTraceId ?? randomUUID;
  const outcomes: TickOutcome[] = new Array(plan.instruments.length);

  // Shared cursor over the plan: each worker claims the next index until the
  // plan is exhausted, so a slow instrument never holds up the queue behind
  // it (orchestrator-spec.md story 5) — unlike fixed-size chunking, where a
  // chunk runs only as fast as its slowest member.
  let cursor = 0;
  const workerCount = Math.min(
    Math.max(Math.floor(config.max_concurrent_instruments), 1),
    plan.instruments.length,
  );

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      const instrument = plan.instruments[index];
      if (instrument === undefined) return;

      const signal: Signal = {
        asset: instrument.asset,
        asset_class: instrument.asset_class,
      };
      const trace_id = newTraceId();

      // #507: this used to be a bare `await` with nothing catching it. One
      // instrument throwing rejected THIS worker's `Promise.all` entry, which
      // settles the whole `Promise.all` immediately — the other workers were
      // still mid-pipeline, still calling out to the LLM, when the tick loop
      // (production.ts's `runOnce`) logged `tick failed` and cleared
      // `inFlight`. That flag is exactly what the NEXT tick's overlap guard
      // tests, so the guard reported the tick as finished while its surviving
      // workers kept running — and kept billing debates unattributed to any
      // live tick.
      //
      // Catching here instead turns one instrument's throw into a failed
      // `TickOutcome` for that instrument alone: this worker's `while` loop
      // keeps claiming indices off the shared `cursor`, so the rest of the
      // plan still runs, and `Promise.all` below only settles once every
      // worker's `while` loop has actually returned — no early exit while
      // siblings are in flight.
      try {
        outcomes[index] = await runner.runInstrument(signal, {
          clock,
          trace_id,
          logger: config.logger,
          auditLog: config.auditLog,
          currentTickStore: config.currentTickStore,
        });
      } catch (error) {
        // Not swallowed: still reaches the logger (so a persistent failure
        // stays visible in the log stream, same as the tick-level catch this
        // supplements) and still lands in the returned outcome array (so a
        // caller reading `outcomes` sees the failure rather than a
        // conspicuously-missing entry — every plan index is always populated).
        const message = error instanceof Error ? error.message : String(error);
        config.logger.log({
          trace_id,
          stage: 'tick-loop',
          level: 'error',
          message: `instrument failed: ${instrument.asset}`,
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: message,
          },
        });
        outcomes[index] = { trace_id, error: message };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return outcomes;
}
