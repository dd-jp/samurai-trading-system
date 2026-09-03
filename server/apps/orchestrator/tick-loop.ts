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
 *
 * ## The phase split (#1040)
 *
 * The cap fans out WHOLE pipelines, which since #1013 set
 * `maxConcurrentInstruments: 6` for paper and live means sibling instruments
 * reach Risk concurrently and each clears the gross-exposure cap against
 * pre-trade exposure (#1019). So this file also owns the other half of the
 * bargain: `TailSequencer` below hands each instrument a turnstile
 * (`TickContext.beginPortfolioTail`) that the runner awaits at its Trader
 * entry point, and turns are granted STRICTLY IN PLAN ORDER. The expensive,
 * portfolio-free head (Analysts + Debate — 93-96% of wall time) still overlaps
 * at the configured width; the portfolio-mutating tail runs one instrument at
 * a time, in the same order every run.
 *
 * No second knob: `max_concurrent_instruments` is the phase-1 limit, which is
 * also what bounds provider burst and the `SpendCap` check-then-act overshoot
 * to at most `(width - 1)` debates in flight. At a width of 1 every turn is
 * already free when it is asked for, so the turnstile is inert and the pass is
 * byte-for-byte the serial pass replay has always run.
 */
import { randomUUID } from 'node:crypto';
import type { Signal } from '../../pipeline/analysts/index.js';
import type { Clock } from '../../shared/index.js';
// #573: `describeThrown`/`safeLog` moved to shared/safe-log.ts once
// execution/ingest-fills.ts and execution/reconcile.ts needed the identical
// "a log call inside a catch must not itself throw" guarantee this file
// worked out first (#507) — see that file's doc for the full reasoning,
// unchanged by the move.
import { describeThrown, safeLog } from '../../shared/index.js';
import type { DecisionGate } from './decision-bar-gate.js';
import { digest } from './digest.js';
import type {
  AuditLog,
  CurrentTickStore,
  DecisionBar,
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
  /**
   * The tick/decision split's gate (#743). Consulted per instrument, per tick:
   * a granted claim rides into `TickContext.decision_bar` and the runner runs
   * the full decision chain; no claim means the tick path only.
   *
   * REQUIRED, not optional, for this repo's standing reason (#364, #388): an
   * optional gate would let a composition root omit it, and the failure mode
   * of omission — every tick a decision — is a silent 30x LLM-spend
   * multiplier that reads as a healthy busy system. A caller that genuinely
   * wants every tick to decide (the backtest harness stepping 1h bars says
   * exactly this) constructs a `DebateBarDecisionGate` and lets every bar
   * claim, which is the same thing stated honestly.
   */
  decisionGate: DecisionGate;
}

/**
 * Orders the portfolio-mutating tails of one plan (#1040).
 *
 * Turns are granted by PLAN INDEX, never by head-completion order — the
 * property ADR-0003 §2's replay-from-log rests on. `begin(i)` resolves when
 * every index below `i` has SETTLED (reached its own tail and finished it, or
 * ended before ever asking for a turn — a quorum skip, a null exit intent, or
 * a head that threw); `finish(i)` is what reports that settlement, and the
 * tick loop calls it from a `finally` so a crash cannot strand the queue.
 *
 * Out-of-order `finish` is normal, not exceptional: an instrument whose head
 * threw settles without ever entering the turnstile, possibly long before the
 * instrument ahead of it. So settlement is recorded in a set and the cursor
 * walks forward over whatever run of settled indices it finds.
 *
 * Deliberately NOT a mutex. A mutex grants in arrival order, which is head
 * completion order — exactly the phase-1 scheduling that must not be
 * observable downstream.
 */
class TailSequencer {
  /** The one index whose tail may run. Advances only over SETTLED indices. */
  #turn = 0;
  #settled = new Set<number>();
  #granted = new Set<number>();
  /** Resolvers for indices that asked for a turn before it was theirs. */
  #waiting = new Map<number, () => void>();

  /**
   * Resolves when it is `index`'s turn. Idempotent: a second call after the
   * turn was granted resolves immediately, so adding a second call site
   * (another Trader entry point, say) cannot deadlock a pass against itself.
   */
  begin(index: number): Promise<void> {
    if (this.#granted.has(index)) return Promise.resolve();
    if (index === this.#turn) {
      this.#granted.add(index);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.set(index, resolve);
    });
  }

  /** Reports that `index`'s pass has settled, whether or not it took a turn. */
  finish(index: number): void {
    this.#settled.add(index);
    while (this.#settled.has(this.#turn)) this.#turn++;
    const waiter = this.#waiting.get(this.#turn);
    if (waiter !== undefined) {
      this.#waiting.delete(this.#turn);
      this.#granted.add(this.#turn);
      waiter();
    }
  }
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
  // The tail turnstile (#1040) — see `TailSequencer`. Built per plan, so its
  // indices are this plan's indices and it cannot outlive the pass.
  const tails = new TailSequencer();
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

      // The decision gate is consulted on the PLAN's tick time, not a fresh
      // clock read (#743): every instrument in one plan must be gated on the
      // same instant — the same argument `UniverseScheduler.nextTick` makes
      // for reading the calendar once — and in replay the plan time is the
      // deterministic coordinate.
      let decisionBar: DecisionBar | undefined;
      try {
        decisionBar = config.decisionGate.claim(instrument.asset, plan.tick_time);
      } catch (error) {
        // The turnstile queue must not be STRANDED if the gate itself throws
        // (#1040). The `finally` below reports this index as settled, but it is
        // only reached once the try block is entered; a throw from the claim
        // would leave every later index waiting on a turn that never comes —
        // promises that never settle, inside a plan that is already failing.
        // Behaviour is otherwise unchanged: a throwing gate still rejects the
        // whole plan through `Promise.all`, exactly as it did before.
        tails.finish(index);
        throw error;
      }

      // See the file header (#507) for why this is caught here rather than
      // left to reject `Promise.all`.
      try {
        outcomes[index] = await runner.runInstrument(signal, {
          clock,
          trace_id,
          logger: config.logger,
          auditLog: config.auditLog,
          currentTickStore: config.currentTickStore,
          // Conditional spread under `exactOptionalPropertyTypes`: absent
          // means "tick path only", never an explicit `undefined`.
          ...(decisionBar === undefined ? {} : { decision_bar: decisionBar }),
          // Supplied unconditionally, at every width (#1040). Passing it only
          // when the width exceeds 1 would make the wide path the only tested
          // one and leave the narrow path taking a second, untested route
          // through the runner — and at a width of 1 the turn is always
          // already free, so the await costs a microtask and changes nothing.
          beginPortfolioTail: () => tails.begin(index),
        });
      } catch (error) {
        // A claimed decision whose pass THREW is handed back to the gate, so
        // the next tick in the same bar retries the decision instead of the
        // bar being silently forfeited to a transient failure (#743). The
        // debate adapter's same-bar memo and the #617 short-circuit make the
        // retry cheap when the failed pass had already persisted its row.
        //
        // The retry is BOUNDED (#785): a persistently failing pass would
        // otherwise rescind every tick for the rest of the bar — up to ~30
        // analyst rebuilds at the production cadence, the exact churn #743
        // exists to remove, reappearing under a sustained fault. Once the
        // gate's retry budget for this bar is exhausted, `rescind` KEEPS the
        // claim (no further retry this bar) and reports `'forfeited'`, which
        // must be reported loudly here — a silent 30x-retry storm and a
        // silently-abandoned bar are both the quiet-tick-vs-broken-system
        // signature #625 exists to keep out of this codebase.
        if (decisionBar !== undefined) {
          const rescindResult = config.decisionGate.rescind(instrument.asset, decisionBar);
          if (rescindResult === 'forfeited') {
            safeLog(config.logger, {
              trace_id,
              stage: 'tick-loop',
              level: 'error',
              message:
                `decision pass retry budget exhausted, bar forfeit: ${instrument.asset} — ` +
                `bar ${decisionBar.id} will run the tick path only for its remainder`,
              payload: {
                instrument: instrument.asset,
                asset_class: instrument.asset_class,
                bar: decisionBar.id,
              },
            });
          }
        }
        // Not swallowed: still reaches the logger, still gets a durable
        // `audit_log` row (below — the runner itself never writes one for a
        // stage that threw mid-call, since `record()` in tick-runner.ts only
        // fires after a stage's step function RETURNS; a crash means "reached
        // a stage but never finished it", which is otherwise invisible to
        // anything reading `audit_log` after the fact), and still lands in
        // the returned outcome array (so a caller reading `outcomes` sees the
        // failure rather than a conspicuously-missing entry — every plan
        // index is always populated).
        //
        // Both side effects below are themselves guarded (#507 review, kimi
        // cycle 2): this whole `catch` exists to guarantee `worker()` cannot
        // reject, and `auditLog.record` is a database write — a SQLite
        // failure here (disk full, handle closed) would otherwise propagate
        // out of THIS catch and reopen the exact orphaned-worker leak #507
        // closes. `logger.log` gets the same treatment for the same reason
        // (see `safeLog`'s doc comment).
        const message = describeThrown(error);
        safeLog(config.logger, {
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
        try {
          // `decision: 'crashed'` has no stage-specific analogue in
          // tick-runner.ts's `record()` calls (`quorum_skip`, `no_trade`,
          // `rejected`, …) on purpose — those all describe a stage that
          // COMPLETED and chose something; this describes a stage that never
          // got the chance to. `input_digest` covers the `Signal` (the one
          // thing known for certain going in, since the runner never told
          // this layer which stage it had reached) rather than nothing, so a
          // crashed pass digests to something other than every other crash
          // on this instrument.
          config.auditLog.record({
            trace_id,
            stage: 'tick-loop',
            decision: 'crashed',
            input_digest: digest(signal),
            output_digest: digest({ error: message }),
            timestamp: clock.now(),
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
          });
        } catch (auditError) {
          // An audit-write failure must stay VISIBLE — this is not the
          // silent-swallow #507 exists to close, it is the same "log it,
          // don't let it propagate" treatment as the instrument crash itself
          // just got, one layer in.
          safeLog(config.logger, {
            trace_id,
            stage: 'tick-loop',
            level: 'error',
            message: `audit_log record failed for crashed instrument: ${instrument.asset}`,
            payload: {
              instrument: instrument.asset,
              asset_class: instrument.asset_class,
              original_error: message,
              audit_error: describeThrown(auditError),
            },
          });
        }
        outcomes[index] = { trace_id, error: message };
      } finally {
        // Reported from a `finally` (#1040), not from the success path: a
        // pass that threw — including one that threw INSIDE its tail, after
        // taking its turn — must still release the queue, or every later
        // instrument in the plan would wait out the tick and the plan would
        // never settle. The catch above already turned the throw into an
        // outcome; this only reports that the pass is over.
        tails.finish(index);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return outcomes;
}
