/**
 * Tick loop — fans a TickPlan out across instruments under a concurrency cap.
 *
 * The cap protects the LLM rate limit shared by Analysts/Debate, not
 * Execution's broker calls. It bounds how many instruments run their
 * pipelines concurrently — never any single instrument's internal latency
 * budget, which the Debate Engine owns.
 *
 * `max_concurrent_instruments: 1` is the sequential mode walk-forward replay
 * needs: it makes the interleaving of stage calls across instruments
 * deterministic (outcomes always come back in plan order regardless of cap).
 *
 * Each worker's `runner.runInstrument` call is wrapped in its own try/catch:
 * one instrument throwing must fail only that instrument, not reject this
 * worker's `Promise.all` entry and settle the whole tick early while sibling
 * workers are still mid-pipeline (and still billing LLM debates).
 *
 * ## The phase split
 *
 * The cap fans out WHOLE pipelines, so at width > 1 sibling instruments reach
 * Risk concurrently and each clears the gross-exposure cap against pre-trade
 * exposure. So this file also owns the other half of the bargain:
 * `TailSequencer` below hands each instrument a turnstile
 * (`TickContext.beginPortfolioTail`) that the runner awaits at its Trader
 * entry point, and turns are granted STRICTLY IN PLAN ORDER. The expensive,
 * portfolio-free head (Analysts + Debate) still overlaps at the configured
 * width; the portfolio-mutating tail runs one instrument at a time, in the
 * same order every run.
 *
 * No second knob: `max_concurrent_instruments` also bounds the `SpendCap`
 * check-then-act overshoot to at most `(width - 1)` debates in flight. At a
 * width of 1 every turn is already free when asked for, so the turnstile is
 * inert and the pass is byte-for-byte the serial pass replay has always run.
 */
import { randomUUID } from 'node:crypto';
import type { Signal } from '../../pipeline/analysts/index.js';
import { LlmRefusalError } from '../../pipeline/debate-engine/index.js';
import type { Clock } from '../../shared/index.js';
// `describeThrown`/`safeLog` live in shared/safe-log.ts: "a log call inside a
// catch must not itself throw" is a guarantee other modules need too.
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
  TickStage,
} from './types.js';

export interface TickLoopConfig {
  /** Simultaneous instrument passes. Values < 1 are clamped to 1. */
  max_concurrent_instruments: number;
  /**
   * Trace-ID source, generated per instrument at Signal emission. Injected
   * rather than called directly so replay can supply a deterministic
   * sequence — random UUIDs can't give byte-identical outcomes across runs.
   */
  newTraceId?: () => string;
  /** Shared structured-logging interface, forwarded into every instrument's TickContext */
  logger: Logger;
  /** shared_store.audit_log writer, forwarded into every instrument's TickContext */
  auditLog: AuditLog;
  /** shared_store.current_tick writer, forwarded into every instrument's TickContext */
  currentTickStore: CurrentTickStore;
  /**
   * The tick/decision split's gate. Consulted per instrument, per tick: a
   * granted claim rides into `TickContext.decision_bar` and the runner runs
   * the full decision chain; no claim means the tick path only.
   *
   * REQUIRED, not optional: an optional gate would let a composition root
   * omit it, and the failure mode of omission — every tick a decision — is a
   * silent 30x LLM-spend multiplier that reads as a healthy busy system. A
   * caller that genuinely wants every tick to decide constructs a
   * `DebateBarDecisionGate` and lets every bar claim, stated honestly.
   */
  decisionGate: DecisionGate;
}

/**
 * Orders the portfolio-mutating tails of one plan.
 *
 * Turns are granted by PLAN INDEX, never by head-completion order — the
 * property replay-from-log rests on. `begin(i)` resolves when every index
 * below `i` has SETTLED (reached its own tail and finished it, or ended
 * before ever asking for a turn); `finish(i)` reports that settlement, called
 * from a `finally` so a crash cannot strand the queue.
 *
 * Out-of-order `finish` is normal: an instrument whose head threw settles
 * without ever entering the turnstile, possibly before the instrument ahead
 * of it. Settlement is recorded in a set and the cursor walks forward over
 * whatever run of settled indices it finds.
 *
 * Deliberately NOT a mutex — a mutex grants in arrival order, which is head
 * completion order, exactly the scheduling that must not be observable
 * downstream.
 */
class TailSequencer {
  /** The one index whose tail may run. Advances only over SETTLED indices. */
  #turn = 0;
  #settled = new Set<number>();
  #granted = new Set<number>();
  /**
   * Indices that asked for a turn before it was theirs, holding BOTH the
   * pending promise and its resolver. The promise is kept, not just the
   * resolver, so a repeated `begin` before the grant hands back the SAME
   * promise instead of overwriting the resolver and orphaning the first
   * caller's await forever.
   */
  #waiting = new Map<number, { promise: Promise<void>; resolve: () => void }>();

  /**
   * Resolves when it is `index`'s turn. Idempotent at every point in the
   * lifecycle — before the grant it hands back the pending promise, at or
   * after the grant it resolves immediately — so a second call site cannot
   * deadlock a pass against itself.
   */
  begin(index: number): Promise<void> {
    if (this.#granted.has(index)) return Promise.resolve();
    if (index === this.#turn) {
      this.#granted.add(index);
      return Promise.resolve();
    }
    const pending = this.#waiting.get(index);
    if (pending !== undefined) return pending.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.#waiting.set(index, { promise, resolve });
    return promise;
  }

  /** Reports that `index`'s pass has settled, whether or not it took a turn */
  finish(index: number): void {
    this.#settled.add(index);
    while (this.#settled.has(this.#turn)) this.#turn++;
    const waiter = this.#waiting.get(this.#turn);
    if (waiter !== undefined) {
      this.#waiting.delete(this.#turn);
      this.#granted.add(this.#turn);
      waiter.resolve();
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
  const outcomes = Array.from<TickOutcome>({ length: plan.instruments.length });

  // Shared cursor over the plan: each worker claims the next index until the
  // plan is exhausted, so a slow instrument never holds up the queue behind
  // it — unlike fixed-size chunking, where a chunk runs only as fast as its
  // slowest member.
  let cursor = 0;
  // Built per plan, so its indices are this plan's indices and it cannot
  // outlive the pass.
  const tails = new TailSequencer();
  const workerCount = Math.min(
    Math.max(Math.floor(config.max_concurrent_instruments), 1),
    plan.instruments.length,
  );

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      const instrument = plan.instruments[index];
      // Returns WITHOUT reporting a turn settled — safe because `cursor++`
      // hands out a dense prefix, so an index never dequeued is strictly
      // greater than every index that could be waiting on a turn. Sparse or
      // out-of-order index allocation would break this and need
      // `tails.finish` here instead.
      if (instrument === undefined) return;

      const signal: Signal = {
        asset: instrument.asset,
        asset_class: instrument.asset_class,
      };
      const trace_id = newTraceId();

      // The decision gate is consulted on the PLAN's tick time, not a fresh
      // clock read: every instrument in one plan must be gated on the same
      // instant, and in replay the plan time is the deterministic coordinate.
      //
      // Not consulted at all when `plan.grace_only`: the US close sits
      // exactly on the debate-bar grid, so an unconditional claim would open
      // a fresh decision bar for a pass whose only possible outcome is the
      // Trader's `skip('session_closing')`, paying a full Analysts + Debate
      // pass to reach it. Leaving `decisionBar` undefined routes the runner
      // to the tick path (`exitCheck` only).
      let decisionBar: DecisionBar | undefined;
      try {
        decisionBar =
          plan.grace_only === true
            ? undefined
            : config.decisionGate.claim(instrument.asset, plan.tick_time);
      } catch (error) {
        // The turnstile queue must not be STRANDED if the gate itself throws:
        // without this, every later index would wait on a turn that never
        // comes. Behaviour is otherwise unchanged — a throwing gate still
        // rejects the whole plan through `Promise.all`.
        tails.finish(index);
        throw error;
      }

      // Caught here, not left to reject `Promise.all` — see file header.
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
          // Supplied unconditionally, at every width: passing it only above
          // width 1 would leave the narrow path on a second, untested route
          // through the runner. At width 1 the turn is always already free.
          beginPortfolioTail: () => tails.begin(index),
        });
      } catch (error) {
        // A claimed decision whose pass THREW is handed back to the gate, so
        // the next tick in the same bar retries the decision instead of the
        // bar being silently forfeited to a transient failure. The retry is
        // BOUNDED: a persistently failing pass would otherwise rescind every
        // tick for the rest of the bar. Once the gate's retry budget for this
        // bar is exhausted, `rescind` KEEPS the claim (no further retry this
        // bar) and reports `'forfeited'`, reported loudly here.
        //
        // A REFUSAL is the one failure that must not be handed back: it's
        // deterministic in the request, so each retry would re-run the whole
        // pass to buy the identical refusal and re-bill every persona that
        // answered before the refusing one. So the claim is KEPT, the bar is
        // forfeit immediately, and the next bar opens with a fresh claim.
        if (decisionBar !== undefined) {
          const refused = error instanceof LlmRefusalError;
          const rescindResult = refused
            ? 'forfeited'
            : config.decisionGate.rescind(instrument.asset, decisionBar);
          if (rescindResult === 'forfeited') {
            safeLog(config.logger, {
              trace_id,
              stage: 'tick-loop',
              event: 'decision_pass_bar_forfeit',
              level: 'error',
              message: refused
                ? `decision pass refused by the provider, bar forfeit: ${instrument.asset} — ` +
                  `bar ${decisionBar.id} will run the tick path only for its remainder, and no ` +
                  'retry is attempted because the refusal is deterministic in the request'
                : `decision pass retry budget exhausted, bar forfeit: ${instrument.asset} — ` +
                  `bar ${decisionBar.id} will run the tick path only for its remainder`,
              payload: {
                instrument: instrument.asset,
                asset_class: instrument.asset_class,
                bar: decisionBar.id,
                reason: refused ? 'refusal' : 'retry_budget_exhausted',
              },
            });
          }
        }
        // Not swallowed: still reaches the logger, still gets a durable
        // `audit_log` row (the runner itself never writes one for a stage
        // that threw mid-call — a crash is otherwise invisible to anything
        // reading `audit_log` after the fact), and still lands in the
        // returned outcome array so every plan index is always populated.
        //
        // Both side effects below are themselves guarded: this whole `catch`
        // exists to guarantee `worker()` cannot reject, and a database write
        // failure here (disk full, handle closed) would otherwise propagate
        // out of THIS catch and reopen the orphaned-worker leak this exists
        // to close.
        const message = describeThrown(error);
        // `current_tick` is upserted before each stage begins and only ever
        // deleted on a pass's SUCCESSFUL terminal path, so a pass that throws
        // mid-stage leaves its own row in place naming the stage it was in.
        // The `trace_id` check confirms the row belongs to THIS pass rather
        // than a stale row a prior crashed pass on the same instrument left
        // behind. Guarded the same way the writes below are: a store read
        // failure here must not turn attribution into a second, unguarded crash.
        let crashedStage: TickStage | undefined;
        try {
          const currentTick = config.currentTickStore.get(instrument.asset);
          crashedStage = currentTick?.trace_id === trace_id ? currentTick.stage : undefined;
        } catch {
          // Falls through with `crashedStage` left `undefined`.
        }
        safeLog(config.logger, {
          trace_id,
          stage: 'tick-loop',
          event: 'instrument_pass_failed',
          level: 'error',
          message: `instrument failed: ${instrument.asset}`,
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: message,
            stage: crashedStage,
          },
        });
        try {
          // `decision: 'crashed'` has no stage-specific analogue in
          // tick-runner.ts's `record()` calls on purpose — those describe a
          // stage that COMPLETED and chose something; this describes a stage
          // that never got the chance to. `input_digest` covers the `Signal`
          // rather than nothing, so a crashed pass digests to something other
          // than every other crash on this instrument.
          //
          // `stage` carries the crashed `TickStage` PREFIXED with the
          // `tick-loop` sentinel rather than written bare: bare would make
          // this row pass the dashboard's `stage IN (…PIPELINE_STAGES)`
          // filter and start folding a crash row into the live lane matrix.
          // The prefix guarantees no PIPELINE_STAGES string can ever equal
          // this value.
          config.auditLog.record({
            trace_id,
            stage: crashedStage === undefined ? 'tick-loop' : `tick-loop:${crashedStage}`,
            decision: 'crashed',
            input_digest: digest(signal),
            output_digest: digest({ error: message }),
            timestamp: clock.now(),
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
          });
        } catch (auditError) {
          // An audit-write failure must stay VISIBLE — the same "log it,
          // don't let it propagate" treatment the instrument crash itself
          // just got, one layer in.
          safeLog(config.logger, {
            trace_id,
            stage: 'tick-loop',
            event: 'audit_log_write_failed',
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
        // Reported from a `finally`, not the success path: a pass that
        // threw — including one that threw INSIDE its tail, after taking its
        // turn — must still release the queue, or every later instrument in
        // the plan would wait out the tick and the plan would never settle.
        tails.finish(index);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return outcomes;
}
