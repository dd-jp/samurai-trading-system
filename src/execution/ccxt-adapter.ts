/**
 * ccxt BrokerAdapter — Kraken/Coinbase (ticket #85). See
 * docs/specs/execution-spec.md ("Module: Broker Abstraction"): "ccxt
 * (Kraken/Coinbase): native attached-close/OCO is limited → Execution-managed
 * emulation — place the entry, arm stop + target on fill, cancel the sibling
 * when one fills. The emulation logic lives in the adapter; the guarantee is
 * identical above it."
 *
 * So this file is where the atomic-bracket/OCO promise is *kept by hand*
 * rather than by the venue. Nothing above the adapter can tell: `execute()`
 * calls `submitBracket` and gets the same `BrokerAck` it gets from a native
 * bracket venue.
 *
 * The ccxt exchange is INJECTED, not constructed here — connection
 * provisioning (API keys, permissions) is an ops/setup task, not this spec's
 * logic, matching the market-data ccxt source (#66). `CcxtBrokerClient` is the
 * narrow slice of ccxt's *order* surface this adapter uses (that source's
 * `CcxtClient` is OHLCV/ticker only), so a real ccxt Exchange satisfies it
 * structurally.
 *
 * #287 made the emulation CRASH-SURVIVABLE. It used to live entirely in this
 * process's memory, so a crash between the entry filling and the protective
 * legs being armed left a live position with no stop on the venue and no local
 * record that one was owed — CONTEXT.md invariant #5 failing silently. The
 * bracket map is now written through to `BrokerStateStore` and rebuilt on
 * construction, and `syncBrackets` knows how to finish an arming episode a
 * previous process started (`recoverArming`).
 */
import { type OrderState, TokenBucket } from '../shared/index.js';
import { sanitizeBrokerError } from './broker-error.js';
import {
  type BrokerBracketPhase,
  type BrokerBracketRecord,
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
} from './broker-state-store.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
} from './types.js';

/** The subset of ccxt's unified order status this adapter reasons about. */
export type CcxtOrderStatus = 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';

/** The ccxt unified order fields this adapter reads. */
export interface CcxtOrder {
  id: string;
  /** 'closed' is ccxt's terminal *filled* state; 'canceled' etc. are dead. */
  status: CcxtOrderStatus;
  /** Cumulative filled base quantity. */
  filled: number;
  /** Volume-weighted fill price; undefined until something fills. */
  average: number | undefined;
  /** Milliseconds since the epoch. */
  timestamp: number | undefined;
  fee: { cost: number } | undefined;
}

export interface CcxtBrokerClient {
  createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<CcxtOrder>;
  cancelOrder(id: string, symbol: string): Promise<unknown>;
  fetchOrder(id: string, symbol: string): Promise<CcxtOrder>;
  /**
   * The order carrying OUR `clientOrderId`, or `null` if the venue
   * AUTHORITATIVELY has no such order (#287).
   *
   * Restart recovery is the only caller, and it is the whole reason this
   * method exists: after a crash mid-arm, the one question that separates
   * "place the leg" from "the leg is already live" is whether the venue
   * already holds an order under the deterministic leg client order id. The
   * null contract is therefore as narrow as `BrokerAdapter.getOrder`'s — an
   * implementation that merely cannot determine the answer MUST throw, because
   * a false null re-places a leg the venue already has and leaves the lot with
   * TWO stops on one position.
   *
   * ccxt's unified surface reaches this differently per venue (some accept
   * `fetchOrder(id, symbol, { clientOrderId })`, others need an
   * `fetchOpenOrders` + `fetchClosedOrders` scan filtered on the field), and
   * support is not universal. Declaring the slice method and leaving the
   * concrete implementation to the injected client is the same posture every
   * other client slice in this repo takes; a venue that cannot answer it at
   * all degrades to a bracket stuck visibly in `arming` rather than one that
   * double-arms.
   */
  fetchOrderByClientOrderId(clientOrderId: string, symbol: string): Promise<CcxtOrder | null>;
}

/**
 * Where a bracket is in the emulated lifecycle. This is the whole of the OCO
 * guarantee: the sibling cancel fires on the `armed` → `resolved` edge, and
 * that edge is taken exactly once because the transition is claimed
 * synchronously (see `advanceExits`).
 *
 * `arming` is not cosmetic — placing the two legs is an await, and without a
 * phase to claim first, two overlapping polls would both place them. Since
 * #287 it is also durable, which is what lets a NEW process discover that a
 * previous one died mid-arm and finish the job.
 */
type BracketPhase = BrokerBracketPhase;

interface EmulatedBracket {
  request: NativeBracketRequest;
  phase: BracketPhase;
  entryOrderId: string;
  stopOrderId: string | null;
  targetOrderId: string | null;
  /**
   * The quantity the live legs currently protect, so a resize can tell a
   * no-op from real work. Null until they are armed.
   */
  armedQty: number | null;
  /**
   * The quantity the IN-FLIGHT arming episode is placing legs for. Written
   * durably at the moment `arming` is claimed, so a recovery in another
   * process sizes the legs to the same quantity the dead one intended rather
   * than re-reading the entry (which may have filled further in between, and
   * would let adopt and place disagree on size inside one episode). Null
   * outside an arming episode.
   */
  armingQty: number | null;
  /**
   * Which arming episode the legs belong to — it fixes the deterministic
   * suffix on each leg's client order id, so a recovery re-arm addresses the
   * SAME leg the venue may already hold and the venue's duplicate-client-order-
   * id rejection stays a real safety net.
   *
   * Incremented when a NEW episode starts (a resize), never inside `armLegs`:
   * the number has to stay stable across a crash for that guarantee to hold.
   */
  armAttempt: number;
  /**
   * PROCESS-LOCAL and deliberately not persisted: true while THIS process is
   * inside an arming episode. It separates "arming, and someone here is on it"
   * from "arming, inherited from a process that died" — the second is what
   * `recoverArming` may touch, the first must be left alone or two overlapping
   * polls arm the same lot twice. A rehydrated bracket is always false, which
   * is exactly right: nobody in this process is on it.
   */
  inFlight: boolean;
}

export class CcxtBrokerAdapter implements BrokerAdapter {
  /**
   * Live brackets by client order id — the emulation's working set, rebuilt
   * from `state` on construction and written through to it on every
   * transition. The Map (not the store) stays the hot path because the OCO
   * guarantee depends on claiming a transition with no `await` in between; see
   * broker-state-store.ts for why that seam is synchronous.
   */
  private readonly brackets = new Map<string, EmulatedBracket>();
  /** Fills awaiting ingestion, in arrival order (#83 drains them). */
  private readonly fills: NormalizedFill[] = [];

  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;

  /**
   * `rateLimiter` is optional so existing wiring keeps working, but the
   * default is NOT "unlimited" — an adapter with no pacing is the C2 finding.
   * 1 order/second is the free-tier order rate Kraken/Coinbase publish for the
   * cheapest tier, so it is the conservative floor that cannot be wrong in the
   * dangerous direction. A placeholder pending real per-venue tuning (#299):
   * an exchange-specific limit belongs with the exchange's credentials, i.e.
   * in ops wiring, not hard-coded here. #299 also records this default's known
   * cost — at 1/second the two protective legs in `armLegs` serialize, placing
   * them ≥1s apart and widening the unprotected-lot window.
   *
   * `state` is optional for the same compatibility reason, but note the
   * asymmetry: the rate-limit default is merely conservative, whereas the
   * in-memory state default IS the bug #287 fixes. Any wiring that means to
   * survive a restart must inject `SqliteBrokerStateStore`.
   */
  constructor(
    private readonly client: CcxtBrokerClient,
    rateLimiter: TokenBucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }),
    state: BrokerStateStore = new InMemoryBrokerStateStore(),
  ) {
    this.rateLimiter = rateLimiter;
    this.state = state;
    this.rehydrate();
  }

  /**
   * Rebuild the emulation from the durable journal (#287). Synchronous, and in
   * the constructor, so no caller can observe a half-cold adapter: the first
   * `submitBracket` after a restart must already know that this client order
   * id is live, or it places a second entry against the same lot.
   *
   * A row whose request columns are absent is skipped rather than
   * half-adopted: those come from a venue-side rehydration path that only ever
   * writes native-bracket venues, so one appearing under `venue = 'ccxt'`
   * would be a schema-level surprise, and a bracket without its request cannot
   * re-place a leg anyway.
   */
  private rehydrate(): void {
    for (const record of this.state.loadBrackets('ccxt')) {
      if (record.request === null || record.entry_order_id === null) continue;

      this.brackets.set(record.client_order_id, {
        request: { client_order_id: record.client_order_id, ...record.request },
        phase: record.phase,
        entryOrderId: record.entry_order_id,
        stopOrderId: record.stop_order_id,
        targetOrderId: record.target_order_id,
        armedQty: record.armed_qty,
        armingQty: record.arming_qty,
        armAttempt: record.arm_attempt,
        inFlight: false,
      });
    }

    this.fills.push(...this.state.loadObservedFills('ccxt'));
  }

  /** Write-through. Always called inside a synchronous claim, never awaited. */
  private persist(bracket: EmulatedBracket): void {
    const { request } = bracket;
    const record: BrokerBracketRecord = {
      venue: 'ccxt',
      client_order_id: request.client_order_id,
      phase: bracket.phase,
      entry_order_id: bracket.entryOrderId,
      stop_order_id: bracket.stopOrderId,
      target_order_id: bracket.targetOrderId,
      request: toRequestFields(request),
      armed_qty: bracket.armedQty,
      arming_qty: bracket.armingQty,
      arm_attempt: bracket.armAttempt,
    };
    this.state.saveBracket(record);
  }

  /**
   * Journal the fill BEFORE the phase write that produced it. A crash in
   * between leaves a persisted fill against a phase that has not moved, so the
   * next poll re-derives the same fill under the same `broker_fill_id`: the
   * TABLE's upsert absorbs it, and the rehydrated in-memory queue then holds
   * it twice, which `ingestFills()` collapses on `broker_fill_id` (its
   * `hasFill` check). A duplicate offer is the fill feed's documented normal —
   * every poll re-offers what it already delivered. The other write order
   * would lose the fill outright, which is the #295 gap for an `armed`
   * bracket, whose entry fill nothing re-derives.
   */
  private recordFill(fill: NormalizedFill): void {
    this.state.saveObservedFill('ccxt', fill);
    this.fills.push(fill);
  }

  /**
   * The single door to the injected client, so the two things every outbound
   * call needs cannot be forgotten on a new one: pacing before (C2) and
   * credential-safe error conversion after (H1). ccxt errors embed the failed
   * HTTP exchange — signed URL, headers, sometimes the key itself — and
   * `execute()` copies a thrown message into a logged `ExecutionResult.reason`.
   *
   * Wrapping at the LEAF, not around the `Promise.all`s: a combinator wrap
   * would double-convert and lose which leg failed.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('ccxt', operation, cause);
    }
  }

  /**
   * Places the ENTRY ONLY. The protective legs cannot be placed yet: they must
   * be sized to the entry's filled quantity, which does not exist until it
   * fills (execution-spec.md user story 13). `syncBrackets` arms them.
   */
  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    // Broker-native dedup: the second layer behind execute()'s store check. A
    // duplicate client order id is a no-op, not a second entry. Since #287
    // this map is rehydrated on construction, so the dedup survives a restart
    // instead of waving through a second entry against a live lot. ccxt's
    // `clientOrderId` param carries the same key to the venue, which rejects
    // the duplicate independently of this map.
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) {
      return this.ackFor(existing);
    }

    const entry = await this.call('submitBracket', () =>
      this.client.createOrder(order.instrument, 'limit', order.side, order.size, order.entry, {
        clientOrderId: order.client_order_id,
        timeInForce: order.time_in_force,
      }),
    );

    const bracket: EmulatedBracket = {
      request: order,
      phase: 'pending_entry',
      entryOrderId: entry.id,
      stopOrderId: null,
      targetOrderId: null,
      armedQty: null,
      armingQty: null,
      armAttempt: 0,
      inFlight: false,
    };
    this.brackets.set(order.client_order_id, bracket);
    this.persist(bracket);

    return this.ackFor(bracket);
  }

  /**
   * Drives the emulation one transition per bracket: finish an arming episode
   * a dead process left behind, arm the legs once the entry fills, then cancel
   * the sibling once an exit leg fills.
   *
   * Deliberately NOT on `BrokerAdapter` — nothing above the adapter should
   * know that this venue needs hand-holding, and the interface stays the one
   * `execute()` calls. Whoever polls this in production is #83's lifecycle
   * work; today its caller is the test suite.
   */
  async syncBrackets(): Promise<void> {
    // Snapshot first: the loop awaits per bracket, and a `submitBracket`
    // landing in one of those gaps mutates the Map mid-iteration — so whether
    // the new bracket is swept this pass or next is decided by timing. A lot's
    // protective legs must not be armed (or not) by a coin flip; the array
    // makes each sweep act on the set that existed when it started.
    const failures: unknown[] = [];

    for (const bracket of [...this.brackets.values()]) {
      // Per-bracket isolation, as `AlpacaBrokerAdapter.fetchNewFills` already
      // does. It matters more since #287: `recoverArming` refuses to guess and
      // therefore throws on an inconclusive venue answer, and one bracket
      // stuck that way must not starve every other bracket's OCO cancel for
      // the rest of the process's life.
      try {
        if (bracket.phase === 'pending_entry') {
          await this.advanceEntry(bracket);
          continue;
        }
        if (bracket.phase === 'arming') {
          await this.resumeArming(bracket);
          continue;
        }
        if (bracket.phase === 'armed') {
          await this.advanceExits(bracket);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      // The causes are inlined into the message, not just carried in
      // `.errors`: this throw reaches an operator as a log line, and "1
      // bracket could not be advanced" without saying why is the least useful
      // possible thing to learn about a lot that may be sitting unprotected.
      // Safe to inline — every one of these has already been through
      // `sanitizeBrokerError`, so no credential can ride along.
      throw new AggregateError(
        failures,
        `ccxt syncBrackets: ${failures.length} bracket(s) could not be advanced: ${failures
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .join('; ')}`,
      );
    }
  }

  /**
   * The reconciliation lookup (#86), served from the rehydrated emulation.
   *
   * ccxt fetches an order by the VENUE's id and symbol, so the client order id
   * has to be resolved through `brackets` — which since #287 is rebuilt from
   * the durable journal on construction, so the crash-restart this method
   * exists to serve no longer finds it empty.
   *
   * It still THROWS rather than returning null for a bracket that is not
   * there, and the reasoning is unchanged: null is reserved by the
   * `BrokerAdapter.getOrder` contract for "the venue authoritatively has no
   * such order", while a miss here is this adapter's ignorance — of an order
   * placed before the journal existed, by another system, or under a client
   * order id this adapter never submitted. Reporting ignorance as absence
   * would have `reconcile()` mark live Kraken/Coinbase positions `rejected`.
   * Reconcile reads the throw as `undetermined` and leaves the record
   * untouched for an operator.
   *
   * One window is left deliberately open, and it is the reason this does NOT
   * fall back to `fetchOrderByClientOrderId` even though the slice now offers
   * it: `submitBracket` journals AFTER `createOrder` returns (it has no venue
   * id to record before then), so a crash inside that call leaves a live entry
   * at the venue with no journal row. Asking the venue here would let
   * `reconcile()` settle such a lot as `submitted`/`filled` — and settle is
   * exactly the wrong outcome, because the emulation still has no bracket for
   * it and will never arm its legs. A lot reported healthy with no protective
   * orders is worse than one flagged `undetermined`, which at least stops an
   * operator. Closing the window properly means write-ahead-with-null-id plus
   * a recovery path for it, which is its own decision (see the PR for #287).
   */
  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) {
      throw new Error(
        `ccxt adapter cannot resolve client_order_id '${clientOrderId}' (${instrument}) to a venue ` +
          "order id: the bracket is in neither this process's emulation state nor the durable " +
          'bracket journal, so this adapter has no record it ever placed it.',
      );
    }

    const entry = await this.call('getOrder', () =>
      this.client.fetchOrder(bracket.entryOrderId, instrument),
    );

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId].filter(
        (id): id is string => id !== null,
      ),
      order_state: mapOrderState(entry),
      filled_qty: entry.filled,
    };
  }

  /**
   * The fill feed #83's `ingestFills()` drains — same contract as the
   * Simulated adapter's, so the lifecycle above is exercised identically in
   * live and backtest. Never returns a fill dated before `since`.
   *
   * Since #287 the queue is rehydrated from `broker_observed_fills` on
   * construction, so a fill observed by a process that died before
   * `ingestFills()` drained it is still delivered (#295).
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.fills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }

  /** `pending_entry` → `arming` → `armed`, or → `resolved` if the entry died. */
  private async advanceEntry(bracket: EmulatedBracket): Promise<void> {
    const { request } = bracket;
    const entry = await this.call('fetchEntryStatus', () =>
      this.client.fetchOrder(bracket.entryOrderId, request.instrument),
    );

    // Claim the transition before any further await, so an overlapping poll
    // cannot place a second pair of legs.
    if (bracket.phase !== 'pending_entry') return;
    if (entry.status === 'open') return;

    if (entry.status !== 'closed' || entry.filled <= 0) {
      // Cancelled/expired/rejected with nothing filled: no lot exists, so
      // there is nothing to protect and no sibling to cancel.
      //
      // A partially-filled-then-cancelled entry DOES leave an unprotected lot.
      // It is not armed here: that is the partial-fill lifecycle (#83) and
      // reconciliation against broker truth (#86), and half-building it here
      // would arm legs against a quantity this adapter cannot yet keep current.
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    // Normalized BEFORE the phase moves: if the venue reported a fill it
    // cannot price, the bracket stays claimable rather than stranded mid-arm.
    // Still synchronous, so the claim below remains atomic.
    const entryFill = this.toFill(entry, 'entry', request.client_order_id);
    this.recordFill(entryFill);

    // WRITE-AHEAD: `arming` is durable BEFORE the first `createOrder`, the
    // same rule `execute()` follows for the store record. Persisting after
    // `armLegs` returned would leave a crash mid-`Promise.all` looking like
    // `pending_entry` on restart — the recovery path would never run, the
    // re-arm would go through `advanceEntry` at the same suffix, and the leg
    // the dead process had already placed would come back as a duplicate
    // rejection with its venue id nowhere recorded.
    bracket.phase = 'arming';
    bracket.armingQty = entry.filled;
    bracket.inFlight = true;
    this.persist(bracket);

    try {
      await this.armLegs(bracket, entry.filled);
    } finally {
      bracket.inFlight = false;
    }
  }

  /**
   * Finish an arming episode that a PREVIOUS process started and did not land
   * (#287's acceptance case: crash between the entry filling and the legs
   * being armed).
   *
   * `inFlight` is what makes this safe to run from the same sweep that arms
   * normally: it is process-local, so it is true only while someone here is
   * mid-`armLegs`, and false on every bracket rehydrated from the journal.
   */
  private async resumeArming(bracket: EmulatedBracket): Promise<void> {
    if (bracket.inFlight) return;

    bracket.inFlight = true;
    try {
      await this.recoverArming(bracket);
    } finally {
      bracket.inFlight = false;
    }
  }

  /**
   * The recovery itself, in two steps, both of which REFUSE RATHER THAN GUESS
   * — the same posture `reconcile()` takes when an adapter cannot answer.
   * Anything inconclusive throws, leaving the bracket in `arming` for the next
   * sweep (or an operator) rather than risking the one outcome the emulation
   * must never produce: two live protective legs on one lot.
   */
  private async recoverArming(bracket: EmulatedBracket): Promise<void> {
    const qty = bracket.armingQty;
    if (qty === null) {
      throw new Error(
        `ccxt bracket '${bracket.request.client_order_id}' is 'arming' with no recorded arming ` +
          'quantity, so its protective legs cannot be sized. Refusing to guess a size for a live ' +
          'position; this bracket needs manual reconciliation against the venue.',
      );
    }

    await this.retireStaleLegs(bracket);

    const [stop, target] = await Promise.all([
      this.adoptOrPlaceLeg(bracket, 'stop', qty),
      this.adoptOrPlaceLeg(bracket, 'target', qty),
    ]);

    this.landArmed(bracket, stop.id, target.id, qty);
  }

  /**
   * Kill any legs still recorded from an EARLIER attempt before placing this
   * attempt's.
   *
   * While the phase is `arming` the recorded ids can only belong to an earlier
   * attempt: `armLegs` writes both ids, `armedQty` and `armed` together, after
   * its await, so a bracket that is `arming` has never had this attempt's ids
   * written. That is what makes "cancel whatever is recorded" safe rather than
   * self-destructive. In practice they are non-null only on the resize path,
   * which claims `arming` while the previous attempt's legs are still live.
   */
  private async retireStaleLegs(bracket: EmulatedBracket): Promise<void> {
    const { request, stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null && targetOrderId === null) return;

    // Status first, cancel second. `sanitizeBrokerError` flattens "already
    // cancelled" and "the exchange is down" into the same `BrokerError`, so a
    // blind tolerant cancel cannot tell a recoverable no-op from a venue this
    // adapter has lost contact with — and treating the second as the first is
    // how a lot ends up with a live stale leg AND a freshly placed one.
    const [stale, staleTarget] = await Promise.all([
      stopOrderId === null
        ? null
        : this.call('fetchStaleStopStatus', () =>
            this.client.fetchOrder(stopOrderId, request.instrument),
          ),
      targetOrderId === null
        ? null
        : this.call('fetchStaleTargetStatus', () =>
            this.client.fetchOrder(targetOrderId, request.instrument),
          ),
    ]);

    // A stale leg that FILLED means the lot exited while this process was
    // dead. Arming a fresh pair would protect a position that no longer
    // exists — a naked exposure in whichever direction the new legs trigger.
    // Booking the exit from here is not this method's job either: that is the
    // OCO edge plus round-trip accounting, and half-doing it against a
    // half-resized lot is exactly the guess `reconcile()` refuses to make.
    for (const [leg, order] of [
      ['stop', stale],
      ['target', staleTarget],
    ] as const) {
      if (order !== null && isFilled(order)) {
        throw new Error(
          `ccxt bracket '${request.client_order_id}': the previous attempt's ${leg} leg ` +
            `(${order.id}) filled while this bracket was mid-arm, so the lot has already exited. ` +
            'Refusing to arm a fresh protective pair over a position that may no longer exist; ' +
            'this bracket needs manual reconciliation against the venue.',
        );
      }
    }

    await Promise.all([
      stale !== null && stale.status === 'open' && stopOrderId !== null
        ? this.call('cancelStaleStopLeg', () =>
            this.client.cancelOrder(stopOrderId, request.instrument),
          )
        : undefined,
      staleTarget !== null && staleTarget.status === 'open' && targetOrderId !== null
        ? this.call('cancelStaleTargetLeg', () =>
            this.client.cancelOrder(targetOrderId, request.instrument),
          )
        : undefined,
    ]);

    bracket.stopOrderId = null;
    bracket.targetOrderId = null;
    this.persist(bracket);
  }

  /**
   * Ask the venue whether this attempt's leg is already there before placing
   * it. The leg's client order id is deterministic in
   * `(client_order_id, leg, armAttempt)`, and `armAttempt` is durable, so the
   * id a recovery asks about is exactly the id the dead process would have
   * used — which is the whole reason `armAttempt` is not incremented inside
   * `armLegs`.
   *
   * A throw out of the lookup propagates: an adapter that cannot confirm the
   * leg is ABSENT must not place one. And only an OPEN leg is adopted — see
   * the refusal below for why a terminal one is not a lesser problem.
   */
  private async adoptOrPlaceLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<CcxtOrder> {
    const legClientOrderId = this.legClientOrderId(bracket, leg);
    const existing = await this.call(
      `fetch${leg === 'stop' ? 'Stop' : 'Target'}LegByClientId`,
      () => this.client.fetchOrderByClientOrderId(legClientOrderId, bracket.request.instrument),
    );

    if (existing === null) return this.placeLeg(bracket, leg, qty);
    if (existing.status === 'open') return existing;

    // Neither absent nor usable. Adopting a terminal leg's id would land the
    // bracket on `armed` while the lot carries at most one live protective
    // leg — the same "live position, no stop" this ticket exists to remove,
    // reached by a different route. Re-placing is not available either: the
    // venue rejects the repeated client order id, and minting a fresh one
    // would defeat the duplicate-rejection safety net the whole recovery rests
    // on. So it refuses, like every other inconclusive answer here.
    throw new Error(
      `ccxt bracket '${bracket.request.client_order_id}': the ${leg} leg '${legClientOrderId}' ` +
        `exists at the venue in terminal state '${existing.status}' (filled ${existing.filled}), ` +
        'so it can be neither adopted as live protection nor re-placed under the same client ' +
        'order id. Refusing to report this lot as armed; it needs manual reconciliation ' +
        'against the venue.',
    );
  }

  /**
   * Places the protective pair sized to `filledSize` — never the requested
   * size, because an over-sized stop protects phantom quantity. The caller
   * owns claiming the phase (`arming`) and persisting that claim; this owns
   * the placement and lands the bracket back on `armed`.
   */
  private async armLegs(bracket: EmulatedBracket, filledSize: number): Promise<void> {
    const [stop, target] = await Promise.all([
      this.placeLeg(bracket, 'stop', filledSize),
      this.placeLeg(bracket, 'target', filledSize),
    ]);

    this.landArmed(bracket, stop.id, target.id, filledSize);
  }

  private async placeLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<CcxtOrder> {
    const { request } = bracket;
    const exitSide = request.side === 'buy' ? 'sell' : 'buy';
    const price = leg === 'stop' ? request.stop : request.target;
    const trigger =
      leg === 'stop' ? { stopLossPrice: request.stop } : { takeProfitPrice: request.target };

    return this.call(leg === 'stop' ? 'armStopLeg' : 'armTargetLeg', () =>
      this.client.createOrder(request.instrument, 'limit', exitSide, qty, price, {
        clientOrderId: this.legClientOrderId(bracket, leg),
        ...trigger,
        timeInForce: request.time_in_force,
      }),
    );
  }

  /**
   * A re-arm cannot reuse a previous attempt's leg client order ids — the
   * venue rejects a repeated one, which within one episode is the safety net
   * recovery relies on, but across episodes would leave a resized lot with no
   * legs at all. The suffix is therefore keyed on the episode.
   */
  private legClientOrderId(bracket: EmulatedBracket, leg: 'stop' | 'target'): string {
    const suffix = bracket.armAttempt === 0 ? '' : `:r${bracket.armAttempt}`;
    return `${bracket.request.client_order_id}:${leg}${suffix}`;
  }

  /** The single `arming` → `armed` write, so the two paths cannot diverge. */
  private landArmed(
    bracket: EmulatedBracket,
    stopOrderId: string,
    targetOrderId: string,
    qty: number,
  ): void {
    bracket.stopOrderId = stopOrderId;
    bracket.targetOrderId = targetOrderId;
    bracket.armedQty = qty;
    bracket.armingQty = null;
    bracket.phase = 'armed';
    this.persist(bracket);
  }

  /**
   * Re-size the live legs to the entry's cumulative filled quantity — the
   * emulation's half of execution-spec.md story 13. First placement is NOT
   * done here: `advanceEntry` already arms at `entry.filled`, and two owners
   * of leg placement is how a lot gets two stops. This only corrects legs
   * already armed against a quantity that has since grown.
   *
   * Cancel-then-replace, because the injected client slice exposes no amend:
   * the lot is briefly unprotected in the gap. That is a real (and venue-
   * inherent) exposure, narrower than leaving the stop sized to a quantity
   * that no longer exists. A crash inside that gap is no longer unrecoverable:
   * the claim below is durable, and `recoverArming` picks the episode up.
   */
  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return;

    // `pending_entry`/`arming` → another transition owns this bracket;
    // `resolved` → the lot is done and its legs are already dead.
    if (bracket.phase !== 'armed') return;
    if (bracket.armedQty === filledQty) return;

    // Claim before the first await, exactly as `advanceEntry`/`advanceExits`
    // do: while re-arming, this bracket is not a candidate for the OCO edge,
    // so a concurrent poll cannot cancel a sibling out from under the replace.
    // The previous attempt's leg ids are deliberately LEFT on the record —
    // they are what tells a recovery which orders still need retiring.
    const { request, stopOrderId, targetOrderId } = bracket;
    bracket.phase = 'arming';
    bracket.armingQty = filledQty;
    bracket.armAttempt += 1;
    bracket.inFlight = true;
    this.persist(bracket);

    try {
      await Promise.all([
        stopOrderId === null
          ? undefined
          : this.call('cancelStopLeg', () =>
              this.client.cancelOrder(stopOrderId, request.instrument),
            ),
        targetOrderId === null
          ? undefined
          : this.call('cancelTargetLeg', () =>
              this.client.cancelOrder(targetOrderId, request.instrument),
            ),
      ]);

      // The old legs are dead: clear them so a recovery does not try to retire
      // orders that are already gone.
      bracket.stopOrderId = null;
      bracket.targetOrderId = null;
      this.persist(bracket);

      await this.armLegs(bracket, filledQty);
    } finally {
      bracket.inFlight = false;
    }
  }

  /**
   * `armed` → `resolved`: the OCO edge. When one protective leg fills, the
   * sibling must die — this is what the venue would do for us on IBKR/Alpaca.
   */
  private async advanceExits(bracket: EmulatedBracket): Promise<void> {
    const { request, stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null || targetOrderId === null) return;

    const [stop, target] = await Promise.all([
      this.call('fetchStopStatus', () => this.client.fetchOrder(stopOrderId, request.instrument)),
      this.call('fetchTargetStatus', () =>
        this.client.fetchOrder(targetOrderId, request.instrument),
      ),
    ]);

    // Everything from here to the phase write is synchronous, which is what
    // makes the cancel exactly-once: a concurrent poll that resolved first has
    // already moved the phase, and a re-observed fill finds `resolved`.
    if (bracket.phase !== 'armed') return;

    const filled = isFilled(stop)
      ? { leg: 'stop' as const, order: stop, siblingId: targetOrderId }
      : isFilled(target)
        ? { leg: 'target' as const, order: target, siblingId: stopOrderId }
        : null;
    if (filled === null) return;

    // Normalized before the phase moves (as in `advanceEntry`): a fill the
    // venue cannot price must not resolve the bracket, or the sibling is never
    // cancelled and the lot is left unprotected. Synchronous, so the claim
    // below stays atomic against a concurrent poll.
    const exitFill = this.toFill(filled.order, filled.leg, request.client_order_id);
    this.recordFill(exitFill);
    bracket.phase = 'resolved';
    this.persist(bracket);

    // If this throws, the bracket stays `resolved` and the sibling outlives
    // its lot — an orphan for #86 to reconcile against broker truth. Retrying
    // here instead would risk the one thing the emulation must never do:
    // cancel twice.
    await this.call('cancelSibling', () =>
      this.client.cancelOrder(filled.siblingId, request.instrument),
    );
  }

  /**
   * Under emulation only the entry exists at ack time; the leg ids appear when
   * `syncBrackets` arms them. Reporting three ids up front would be inventing
   * two the venue has never heard of.
   */
  private ackFor(bracket: EmulatedBracket): BrokerAck {
    const ids = [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId];
    return {
      client_order_id: bracket.request.client_order_id,
      broker_order_ids: ids.filter((id): id is string => id !== null),
      order_state: 'submitted',
    };
  }

  /**
   * Polling reports the order's *aggregate* fill, so one NormalizedFill per
   * leg rather than one per venue trade. `cost_breakdown` is absent by
   * contract: a real venue fill has no modeled breakdown.
   */
  private toFill(
    order: CcxtOrder,
    leg: NormalizedFill['leg'],
    clientOrderId: string,
  ): NormalizedFill {
    if (order.average === undefined) {
      throw new Error(
        `ccxt order ${order.id} reports filled ${order.filled} but no average fill price to record`,
      );
    }
    if (order.timestamp === undefined) {
      throw new Error(`ccxt order ${order.id} has no timestamp to date its fill`);
    }

    return {
      client_order_id: clientOrderId,
      broker_fill_id: order.id,
      leg,
      price: order.average,
      qty: order.filled,
      // ccxt reports no fee where the venue returned none; a missing fee is
      // zero cash paid, not an unknown.
      fee: order.fee?.cost ?? 0,
      timestamp: new Date(order.timestamp),
    };
  }
}

function isFilled(order: CcxtOrder): boolean {
  return order.status === 'closed' && order.filled > 0;
}

/**
 * ccxt's unified order status → our `OrderState`, for the reconciliation
 * lookup. Never `closed`: that is our round-trip-to-flat accounting concept
 * derived from `Fill` rows, not a thing a venue says about an order — ccxt's
 * confusingly-named `'closed'` means the order finished filling.
 */
function mapOrderState(order: CcxtOrder): OrderState {
  switch (order.status) {
    case 'closed':
      return 'filled';
    case 'canceled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    // Still working: whether anything has filled is what separates an
    // acknowledged order from a partially filled one.
    default:
      return order.filled > 0 ? 'partially_filled' : 'submitted';
  }
}
