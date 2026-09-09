/**
 * `MiRefreshQueue` — the market-intelligence refresh, moved off the analyst
 * stage's critical path and serialised behind one spend check (#1085).
 *
 * ## What this is for
 *
 * A full MI refresh is two LLM round trips deep (news scoring, then X
 * retrieval) and costs seconds, not milliseconds. Awaited per instrument
 * inside the analyst stage, it made the pass longer than the tick interval, at
 * which point the scheduler drops instruments (#1084) — so the refresh must
 * not be on the stage's critical path at all.
 *
 * ## Why a queue rather than "stop awaiting it" or "give it its own timer"
 *
 * The property `composeMarketIntelligence` exists to protect is that two
 * metered calls must not both pass a `SpendCap.check()` that the pair would
 * fail — the cap is a pure read over `llm_spend` and reserves nothing, so
 * concurrent callers all see the same pre-spend total.
 *
 * **`composeMarketIntelligence`'s sequencing alone does not give that
 * property.** #1013 admits up to `min(6, universe.length)` instrument passes
 * concurrently, and `composeMarketIntelligence` is called *inside* each pass's
 * analyst stage — so its ordering holds only within one instrument, while
 * several instruments' refreshes race the same total. Simply not awaiting the
 * refresh is strictly worse: it removes the only thing bounding how many
 * refreshes are in flight. A separate timer is what
 * `AnalystsStepOptions.marketIntelligence` already argues against — it would
 * run outside the tick's in-flight guard and outside the session the scheduler
 * defines.
 *
 * So: the tick still triggers the refresh (nothing runs outside the session),
 * the trigger returns immediately (nothing blocks an analyst), and ONE worker
 * drains the queue with ONE cap check in front of each dispatch. Serialising
 * globally is what makes the cap property true for the first time rather than
 * merely preserved.
 *
 * ## The cap check here is not a duplicate
 *
 * `GrokAgent` reads the cap itself before its own call, and `MiIngestAgent`
 * now does too (#1106) — before, it scored through the shared `LlmClient`,
 * which METERS into `llm_spend` but was gated by nothing, so the check below
 * was the only ceiling the news-scoring path had, and only while ingest
 * happened to run first in the composition root's array. With both agents
 * self-gating, that array order is no longer load-bearing, and the check
 * below is a cheap outer bound on the whole composed pass rather than the
 * only ceiling either agent has.
 *
 * ## Cost of the choice
 *
 * Latency becomes a global MI throughput ceiling: when a refresh bucket rolls,
 * every name in the universe comes due at once and the sweep is one
 * (news + social) pair at a time, so a name at the back of the queue gets its
 * `social` bucket minutes late. That is affordable precisely because it is off
 * the critical path and because the analysts read a 24h window
 * (`COVERAGE_WINDOW_MS`) against a minutes-scale tick — a slightly staler
 * context is not a worse one.
 *
 * NEVER THROWS AND NEVER REJECTS, holding the seam's existing promise: an MI
 * outage degrades the debate to `NO_DATA_MARKER`, it does not fail a tick that
 * would otherwise have traded.
 */
import {
  type SpendCap,
  type SpendCapRefusalKind,
  type SpendCapVerdict,
  spendCapRefusalRemedy,
} from '../../../pipeline/debate-engine/index.js';
import type { AssetClass, Logger } from '../../../shared/index.js';
import { logCaughtFailure, runWithTraceId, safeLog } from '../../../shared/index.js';
import type { MarketIntelligenceRefresh } from './analysts-adapter.js';

/**
 * The trace id every queued refresh runs under.
 *
 * A dedicated id, matching `FILL_SYNC_TRACE_ID` and the GDELT/Polymarket
 * pollers, rather than the tick's: the call lands after the tick that asked
 * for it has closed, so stamping the tick's id onto a `market_intelligence`
 * log line (and onto the `llm_spend` row behind it) would place off-tick work
 * inside a finished trace. The requesting id is carried in the queue's own log
 * payload as `requested_by`, which is where the join belongs.
 */
export const MI_REFRESH_TRACE_ID = 'mi-refresh';

/**
 * How often a spend-cap refusal is logged: the first, then every 20th —
 * PER `SpendCapVerdict.kind` (#1376).
 *
 * Same first-then-every-Nth convention as `ALERT_REPEAT_EVERY_SKIPS`. On a
 * budget refusal the cap does not refill, so once it is reached every queued
 * instrument refuses on every sweep — an unthrottled line would be one per
 * name per sweep for the rest of the run. A fault refusal carries no such
 * guarantee: it can clear before the next sweep. The breach itself is
 * escalated once by `SqliteSpendCap`'s own `onBreach`, so nothing depends on
 * this line to be seen.
 *
 * `#refusalsByKind` counts each kind separately, which is the invariant this
 * throttle holds: the first refusal of EACH kind logs un-throttled, whatever
 * kind (if any) was logged before it. A `read_fault` refusal cannot consume
 * the budget kind's un-throttled first slot — each kind's remedy text is
 * guaranteed to reach the log the first time that kind is seen, independent
 * of every other kind.
 */
export const REFUSAL_LOG_EVERY = 20;

export interface MiRefreshQueueDeps {
  /** The composed agents (`composeMarketIntelligence`), run one instrument at a time. */
  refresher: MarketIntelligenceRefresh;
  /** Read once per dispatch, on the worker, so no two MI calls race the same total. */
  spendCap: SpendCap;
  logger?: Logger | undefined;
}

interface QueuedRefresh {
  instrument: string;
  assetClass: AssetClass;
  /** The tick that asked, for the log payload only — never the call's own trace id. */
  requestedBy: string;
}

export class MiRefreshQueue implements MarketIntelligenceRefresh {
  /**
   * Instruments waiting, in request order, at most one entry each.
   *
   * A `Map` keyed by instrument is the whole backpressure story: the queue can
   * never grow past the universe however far the worker falls behind, and a
   * name cannot starve because `Map` iterates in insertion order.
   */
  readonly #pending = new Map<string, QueuedRefresh>();

  /** The instrument being refreshed right now, so a re-request cannot queue a duplicate of it. */
  #inFlight: string | undefined;

  /** The worker, held as a promise so `stop()` can drain it at shutdown. */
  #worker: Promise<void> | undefined;

  #stopped = false;

  /**
   * Refusal count per `SpendCapVerdict.kind`, so each kind's log throttle is
   * independent of every other kind — see `REFUSAL_LOG_EVERY`.
   */
  readonly #refusalsByKind = new Map<SpendCapRefusalKind, number>();

  /**
   * Instruments whose refresh has been ATTEMPTED to completion at least once
   * in this process — success, failure and spend refusal all count.
   *
   * Read by the coverage check (`CheckMiCoverageDeps.refreshAttempted`), which
   * must not alert `mi_no_data` for a name MI has not looked at yet. Attempted
   * rather than succeeded on purpose: a name whose refresh failed or was
   * refused has no data and is not going to get any, so it must alert.
   *
   * FIRST LOOK ONLY, never per request, and nothing evicts. A name the worker
   * has swept once stays marked while its later re-requests sit in the queue,
   * so a deep backlog does NOT re-suppress its alert. That is deliberate: the
   * suppression exists to cover the one window this ticket opened — a name the
   * process has never yet fetched for — and past that first sweep a miss is a
   * real miss whatever the queue depth is.
   */
  readonly #attempted = new Set<string>();

  constructor(private readonly deps: MiRefreshQueueDeps) {}

  /**
   * Enqueues a refresh and returns at once.
   *
   * The `false` is not a fabricated success: `MarketIntelligenceRefresh`'s
   * boolean means "did this call put new items where the analysts about to run
   * can see them", and for a queued refresh the answer for THIS tick is
   * always no. The only caller (`buildAnalystsStep`) discards it.
   */
  async refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean> {
    if (this.#stopped) return false;
    if (this.#inFlight !== instrument && !this.#pending.has(instrument)) {
      this.#pending.set(instrument, { instrument, assetClass, requestedBy: trace_id });
    }
    this.#pump();
    return false;
  }

  /** Whether `instrument`'s refresh has run to completion at least once — see `#attempted`. */
  refreshAttempted(instrument: string): boolean {
    return this.#attempted.has(instrument);
  }

  /** Instruments waiting plus the one in flight — a diagnostic read, gates nothing. */
  get depth(): number {
    return this.#pending.size + (this.#inFlight === undefined ? 0 : 1);
  }

  /**
   * Stops taking new work and awaits the refresh already dispatched.
   *
   * `stop()`, deliberately NOT `whenIdle()`. It shares the reason
   * `GdeltIngestAgent.whenIdle` / `PolymarketAgent.whenIdle` exist — the
   * in-flight refresh ends in an archive and store write, which without a
   * drain can land after the store is closed — but not their contract: those
   * two only await and can be called mid-run, while this one latches
   * `#stopped` and is one-way. Naming it `whenIdle` would invite a caller to
   * use it as a quiescence probe and silently end MI for the rest of the run.
   *
   * The latch is load-bearing, and the difference is what starts the work. A
   * GDELT poll can only be started by its interval, and the orchestrator's
   * `stop()` clears that interval before it drains, so nothing can arrive
   * mid-drain. THIS queue is started by the analyst stage, and the
   * orchestrator drains the tick loop CONCURRENTLY with this call — so an
   * analyst stage still finishing inside that drain would keep enqueueing
   * refreshes, and an await-only drain could chase a queue that keeps
   * refilling and permit exactly the late store write it exists to prevent.
   *
   * Being one-way is sound because there is no restart path: `index.ts` calls
   * `start()` exactly once per process, and the orchestrator's `stop()` is the
   * shutdown handler that runs before exit. If a restart is ever added, this
   * must be split — an unlatching drain, and the latch left here — or MI will
   * silently never refresh again.
   *
   * There is no timer to clear either, this worker being enqueue-driven, so a
   * test that never calls this leaks nothing.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending.clear();
    await this.#worker;
  }

  /** Starts the worker if it is not already running; re-arms it if work arrived as it finished. */
  #pump(): void {
    if (this.#worker !== undefined) return;
    // DEFERRED, not called inline, and this is the whole single-worker
    // guarantee. `#drain()` is an async function: calling it runs its body
    // SYNCHRONOUSLY as far as its first await — through `spendCap.check()`
    // and on into the refresher's own synchronous prefix — which is before
    // `#worker` is assigned on the next line. A refresher that enqueues from
    // that prefix would re-enter `#pump`, see no worker, and start a second
    // one: two dispatches overlapping, both reading the same pre-spend total
    // and both admitted, which is the one invariant this class exists for.
    // Scheduling the drain on a microtask closes the window, because nothing
    // else can run between here and the assignment below.
    // Under `MI_REFRESH_TRACE_ID`, matching the id `#dispatch` threads
    // explicitly. `AsyncLocalStorage` captures at REGISTRATION, so without
    // this the drain inherits whichever tick's analysts step happened to call
    // `refresh()` — and since one drain serves every queued name, and `rearm`
    // re-enters from that same captured context, a later instrument's refresh
    // would be stamped with an earlier instrument's tick. That is a wrong
    // join, not a missing one. The work is off the tick's critical path
    // (#1085) and `refresh()` returns `false` because no tick waits on it, so
    // no tick's id is the honest answer here.
    const worker = Promise.resolve().then(() =>
      runWithTraceId(MI_REFRESH_TRACE_ID, () => this.#drain()),
    );
    this.#worker = worker;
    // The window between `#drain` seeing an empty queue and this callback is
    // reachable from `refresh()`, and an enqueue landing in it would find
    // `#worker` still set and return without starting anything. Re-checking
    // here is what keeps that request from being stranded until the next one.
    const rearm = (): void => {
      this.#worker = undefined;
      if (!this.#stopped && this.#pending.size > 0) this.#pump();
    };
    // Both handlers, not just fulfilment: `#drain` is written not to reject,
    // and a queue that could be left permanently holding a settled `#worker`
    // would silently stop refreshing for the rest of the run if it ever did.
    void worker.then(rearm, rearm);
  }

  /** Never rejects: every failure mode is caught and logged inside the loop. */
  async #drain(): Promise<void> {
    while (!this.#stopped && this.#pending.size > 0) {
      const next = this.#pending.values().next();
      if (next.done === true) return;
      const request = next.value;
      this.#pending.delete(request.instrument);
      this.#inFlight = request.instrument;
      try {
        await this.#dispatch(request);
      } finally {
        // In `finally`, not after the await: `#dispatch` is written not to
        // throw, but a queue that could strand `#inFlight` on a throw would
        // silently refuse every later refresh of that instrument.
        this.#attempted.add(request.instrument);
        this.#inFlight = undefined;
      }
    }
  }

  /**
   * One instrument's refresh, behind the cap check that makes this queue worth
   * serialising. Never throws — the cap read is inside the guard too, because
   * an injected cap that throws would otherwise take the worker down and stop
   * every later instrument refreshing.
   */
  async #dispatch(request: QueuedRefresh): Promise<void> {
    try {
      const spend = this.deps.spendCap.check();
      if (!spend.admitted) {
        this.#logRefusal(request, spend);
        return;
      }
      await this.deps.refresher.refresh(
        MI_REFRESH_TRACE_ID,
        request.instrument,
        request.assetClass,
      );
    } catch (error) {
      // `composeMarketIntelligence` already swallows a single agent's throw,
      // and both shipped agents catch internally. This is the outermost guard
      // for anything that forgets: an unhandled rejection here would escape
      // into the worker and take the whole queue down with it, which is the
      // one failure mode a refresh off the critical path can still cause.
      if (this.deps.logger !== undefined) {
        logCaughtFailure(
          this.deps.logger,
          {
            trace_id: MI_REFRESH_TRACE_ID,
            stage: 'market_intelligence',
            event: 'mi_refresh_threw',
            level: 'warn',
            message:
              `market intelligence: the queued refresh for ${request.instrument} threw; that ` +
              'name adds nothing this sweep and its news-fed analysts will report NO DATA. ' +
              'Not fatal — the queue continues with the next instrument.',
          },
          error,
        );
      }
    }
  }

  #logRefusal(request: QueuedRefresh, spend: Extract<SpendCapVerdict, { admitted: false }>): void {
    const refusalsOfKind = (this.#refusalsByKind.get(spend.kind) ?? 0) + 1;
    this.#refusalsByKind.set(spend.kind, refusalsOfKind);
    if (refusalsOfKind !== 1 && refusalsOfKind % REFUSAL_LOG_EVERY !== 0) return;
    if (this.deps.logger === undefined) return;
    safeLog(this.deps.logger, {
      trace_id: MI_REFRESH_TRACE_ID,
      stage: 'market_intelligence',
      event: 'mi_refresh_refused_spend_cap',
      level: 'warn',
      message:
        `market intelligence: refresh for ${request.instrument} not started — ` +
        `${spend.reason ?? 'spend cap reached'}. No LLM call was made. ` +
        `${spendCapRefusalRemedy(spend.kind)} The news-fed analysts report NO DATA ` +
        'on whatever the archive already holds.',
      payload: {
        instrument: request.instrument,
        asset_class: request.assetClass,
        requested_by: request.requestedBy,
        spent_usd: spend.spent_usd,
        budget_usd: spend.budget_usd,
        kind: spend.kind,
        refusals_of_kind: refusalsOfKind,
      },
    });
  }
}
