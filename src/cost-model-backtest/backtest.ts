/**
 * Backtest harness — injected-clock replay of the live pipeline (ticket #88).
 * See docs/specs/cost-model-backtest-spec.md ("Module: Backtest Harness").
 *
 * The harness drives the *same* tick loop the live system runs: it steps a
 * `SimulatedClock` bar-by-bar and calls the Orchestrator's `Scheduler` +
 * `TickRunner` (orchestrator-spec.md; implementations are ticket #94). It
 * deliberately contains no pipeline logic of its own — re-implementing the
 * stage chain here would make the spec's "same code path" guarantee false by
 * construction, which is the one property this component exists to provide.
 * Live and replay differ only in the injected clock, data sources and broker
 * adapter; all of those are wired by the caller (the composition root), not
 * here.
 *
 * **No-lookahead (spec: audited like a security vulnerability).** The audit is
 * enforced at the data seam, not here: the composition root wraps the data
 * sources/stores it injects into the stages with `LookaheadAuditor`, which
 * throws `LookaheadViolationError` on any row stamped after `clock.now()`.
 * `run` does not catch it — the throw propagates out of `runInstrument` and
 * fails the whole run, so no report and no trades are produced from a replay
 * that peeked at the future.
 */
import type { Signal } from '../analysts/index.js';
import type { Scheduler, TickContext, TickOutcome, TickRunner } from '../orchestrator/index.js';
import type { Clock, SimulatedClock } from '../shared/index.js';
import type { Backtest, BacktestConfig, BacktestReport, ReplayTimeline } from './types.js';
import { assertSurvivorshipFree, type InstrumentRegistry } from './universe.js';

export interface BacktestDeps {
  /**
   * The Orchestrator's scheduler (#94), wired by the caller with the *same*
   * universe as `BacktestConfig.universe` — the scheduler owns universe
   * iteration per orchestrator-spec, so it is what actually keeps delisted
   * names in the replay; the harness asserts the universe is survivorship-free
   * before the first bar and never filters instruments itself.
   */
  scheduler: Scheduler;
  /** The Orchestrator's tick loop (#94) — the live code path under replay. */
  tickRunner: TickRunner;
  timeline: ReplayTimeline;
  registry: InstrumentRegistry;
  /**
   * Builds the per-instrument `TickContext`. Supplied by the caller because
   * the Orchestrator wires stage instances and owns trace-ID generation
   * (#95) — the harness only guarantees the clock inside it is the simulated
   * one. Must be deterministic for a replay to be reproducible: a random
   * trace ID here makes the run's audit trail differ between runs even though
   * the trades match.
   */
  newTickContext(signal: Signal, clock: Clock): TickContext;
}

export class BacktestHarness implements Backtest {
  constructor(private readonly deps: BacktestDeps) {}

  async run(config: BacktestConfig, clock: SimulatedClock): Promise<BacktestReport> {
    // Survivorship gate first: a biased universe invalidates the run, so fail
    // before any bar is stepped rather than after producing trades.
    await assertSurvivorshipFree(config.universe, config.window, this.deps.registry);

    const bars = await this.deps.timeline.barTimestamps(config.window);
    assertWithinWindow(bars, config);

    const tickOutcomes: TickOutcome[] = [];

    for (const bar of bars) {
      // Monotonic by construction: `advanceTo` throws on a backwards step, so
      // an unsorted timeline fails the run instead of silently rewinding T.
      clock.advanceTo(bar);

      const plan = this.deps.scheduler.nextTick(clock);

      // Sequential, never concurrent: walk-forward replay needs deterministic
      // ordering, not throughput (spec, "Module: Backtest Harness" — the
      // concurrency cap runs sequentially in backtest for determinism).
      for (const instrument of plan.instruments) {
        const signal: Signal = {
          asset: instrument.asset,
          asset_class: instrument.asset_class,
        };
        const ctx = this.deps.newTickContext(signal, clock);
        tickOutcomes.push(await this.deps.tickRunner.runInstrument(signal, ctx));
      }
    }

    return {
      config_hash: config.config_hash,
      seed: config.seed,
      tick_outcomes: tickOutcomes,
      lookahead_audit: 'passed',
    };
  }
}

/**
 * A bar outside the configured window is a point-in-time breach in the data
 * the harness was handed: a bar after `window.end` is future data, and one
 * before `window.start` silently widens the sample the config claims to have
 * been evaluated over. Both fail the run.
 */
function assertWithinWindow(bars: readonly Date[], config: BacktestConfig): void {
  const { start, end } = config.window;

  for (const bar of bars) {
    if (bar.getTime() < start.getTime() || bar.getTime() > end.getTime()) {
      throw new Error(
        `Replay timeline returned a bar at ${bar.toISOString()} outside the configured window ` +
          `${start.toISOString()}..${end.toISOString()} (config_hash=${config.config_hash}).`,
      );
    }
  }
}
