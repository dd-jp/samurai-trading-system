/**
 * Locally emulated protective legs for Alpaca CRYPTO (#586).
 *
 * Alpaca rejects EVERY advanced order class for crypto — `order_class:
 * 'bracket'`/`'otoco'` and `'oco'` alike come back `422 {"code":42210000,
 * "message":"crypto orders not allowed for advanced order_class"}`, verified
 * live in #550 — so a crypto instrument can never get the venue-kept
 * entry + one-cancels-other guarantee `AlpacaBrokerAdapter` relies on for
 * equities. The owner's recorded decision on #586 is option (a): keep the
 * guarantee BY HAND, below the `BrokerAdapter` seam, exactly as the retired
 * ccxt adapter did for venues without native brackets (its emulation is the
 * pattern this module ports — `git show fe79f26 -- src/execution/ccxt-adapter.ts`).
 *
 * The lifecycle, all of it journalled in `broker_brackets` (venue 'alpaca',
 * distinguishable from native rows by `asset_class = 'crypto'` on the
 * journalled request) with every transition written BEFORE the venue call it
 * commits to:
 *
 *   submitting        — write-ahead row, before the plain-limit ENTRY is sent
 *   pending_entry     — entry live; the intended stop/target prices ride in
 *                       the journalled request, waiting on the entry fill
 *   arming            — entry fill observed by the sweep; the two protective
 *                       legs are being placed as PLAIN crypto orders
 *                       (stop_limit for the stop, limit for the take-profit)
 *   armed             — both legs resting; the sweep watches for either fill
 *   cancelling_sibling— one leg observed filled; the sibling's cancel is owed
 *                       (migration 0022) — written before the cancel call
 *   resolved          — done: sibling cancelled, or nothing left to protect
 *
 * ## The accepted double-fill window
 *
 * Between two fill polls NOTHING enforces the exclusion: the stop and the
 * take-profit rest as independent orders, and a market that trades through
 * both prices inside one poll interval fills BOTH — over-closing the lot and
 * opening a reverse position. The owner accepted this risk when choosing
 * emulation (#586); when the sweep observes it, both fills are booked
 * truthfully and `OcoDoubleFillAlertChannel` is posted — alerted, never
 * hidden, and never auto-unwound (see oco-double-fill-alert.ts).
 *
 * ## What is journalled here vs. left to #549
 *
 * The journal is honest about every window — a crash mid-arm leaves
 * `arming`, a crash mid-cancel leaves `cancelling_sibling` — and THIS
 * process's fill sweep resumes both from the journal on the next poll. What
 * is deliberately NOT built here is #549's durable "residual unprotected"
 * flag swept on its own cadence: a lot whose recovery keeps failing (or
 * whose entry filled partially and then died) is retried/refused loudly by
 * this sweep, but no separate escalation clock runs on it yet.
 *
 * Quantities go to the wire as `String(qty)` with no rounding — the same
 * treatment `AlpacaBrokerAdapter.submitFlatten`/`submitBracket` give every
 * other order's size.
 */
import type { Clock } from '../../shared/index.js';
import type { BrokerBracketRecord, BrokerStateStore } from '../broker-state-store.js';
import { toRequestFields } from '../broker-state-store.js';
import type { OcoDoubleFillAlertChannel } from '../oco-double-fill-alert.js';
import type { BrokerAck, NativeBracketRequest, NormalizedFill } from '../types.js';
import type { AlpacaClient, AlpacaOrder } from './alpaca-client.js';
// The shared normalization layer (alpaca-order-normalization.ts, split out on
// PR #600 review): sharing the adapter's own fill normalization —
// `collectFill`'s unpriced-fill refusal included — without importing the
// adapter back, which would be a runtime cycle (the adapter constructs this
// class).
import {
  collectFill,
  mapOrderState,
  toAlpacaSymbol,
  UnpricedFillError,
} from './alpaca-order-normalization.js';

/**
 * One emulated bracket — the in-process working set, ccxt's `EmulatedBracket`
 * shape plus two process-local flags of this module's own. The Map stays the
 * hot path for the same reason ccxt's did: the exactly-once sibling cancel
 * depends on claiming a phase transition with no `await` in between, and
 * `BrokerStateStore` is synchronous so the journal write sits inside the
 * claim (broker-state-store.ts's file doc).
 */
interface EmulatedBracket {
  request: NativeBracketRequest;
  phase: BrokerBracketRecord['phase'];
  /** Null ONLY in `submitting` (#312's write-ahead rule, inherited intact). */
  entryOrderId: string | null;
  stopOrderId: string | null;
  targetOrderId: string | null;
  armedQty: number | null;
  armingQty: number | null;
  /** Fixes the deterministic leg client-order-id suffix — durable, never bumped mid-episode. */
  armAttempt: number;
  /** PROCESS-LOCAL: an arming episode is in flight HERE. See ccxt's original doc. */
  inFlight: boolean;
  /**
   * PROCESS-LOCAL: the double-fill alert for this lot was delivered by this
   * process. Deliberately not persisted — the detection below re-derives the
   * condition from venue state on every sweep, so the cost of losing this
   * flag to a restart is one repeated alert, and the alternative (a durable
   * flag whose write races the alert) can lose the alert outright. Noisy,
   * never silent.
   */
  doubleFillAlerted: boolean;
  /**
   * PROCESS-LOCAL: every order of this resolved bracket has been seen
   * terminal by a sweep in THIS process, so its fills have been re-derived
   * and offered at least once since the last restart and there is nothing
   * left to observe. Skipped by later sweeps to bound the poll cost (three
   * `getOrder`s per bracket per 15s sweep against a ~200 req/min account
   * budget — the same leak the flatten sweep's pruning fixed in #524).
   * Not persisted: a restart re-polls once, which is exactly what re-offers
   * a fill the dead process observed but never ingested.
   */
  donePolling: boolean;
}

export interface AlpacaCryptoLegEmulationDeps {
  client: AlpacaClient;
  state: BrokerStateStore;
  clock: Clock;
  /**
   * The adapter's single outbound door (`AlpacaBrokerAdapter`'s private
   * `call`): pacing before the venue call, credential-safe error conversion
   * after. Injected so this module cannot grow a second, unpaced path to the
   * client.
   */
  call: <T>(operation: string, fn: () => Promise<T>) => Promise<T>;
  /** Where an observed double fill is escalated — see oco-double-fill-alert.ts. */
  doubleFillAlerts: OcoDoubleFillAlertChannel;
}

export class AlpacaCryptoLegEmulation {
  private readonly brackets = new Map<string, EmulatedBracket>();

  /**
   * Rehydration mirrors ccxt's: synchronous, in the constructor, so the first
   * `submitBracket` after a restart already knows this client order id is
   * live. Only rows whose journalled request says `asset_class: 'crypto'`
   * belong to this emulation — every emulated row has a full request (the
   * write-ahead saves it), so a request-less row is a native equity one by
   * construction and is left to the adapter's own warm-load.
   */
  constructor(private readonly deps: AlpacaCryptoLegEmulationDeps) {
    for (const record of deps.state.loadBrackets('alpaca')) {
      if (record.request === null || record.request.asset_class !== 'crypto') continue;
      if (record.entry_order_id === null && record.phase !== 'submitting') continue;

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
        doubleFillAlerted: false,
        donePolling: false,
      });
    }
  }

  /** Whether this client order id is an emulated crypto bracket of ours. */
  owns(clientOrderId: string): boolean {
    return this.brackets.has(clientOrderId);
  }

  /** The venue order ids known for an owned bracket, entry first. */
  brokerOrderIds(clientOrderId: string): string[] {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return [];
    return [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId].filter(
      (id): id is string => id !== null,
    );
  }

  /** Write-through. Always called inside a synchronous claim, never awaited. */
  private persist(bracket: EmulatedBracket): void {
    this.deps.state.saveBracket({
      venue: 'alpaca',
      client_order_id: bracket.request.client_order_id,
      phase: bracket.phase,
      entry_order_id: bracket.entryOrderId,
      stop_order_id: bracket.stopOrderId,
      target_order_id: bracket.targetOrderId,
      request: toRequestFields(bracket.request),
      armed_qty: bracket.armedQty,
      arming_qty: bracket.armingQty,
      arm_attempt: bracket.armAttempt,
    });
  }

  /**
   * The crypto ENTRY: a plain limit order — no `order_class`, no attached
   * legs (the guaranteed 422) — write-ahead journalled as `submitting`
   * BEFORE the venue call, with the caller's already-computed stop/target
   * riding in the journalled request as the legs owed once the entry fills.
   *
   * ccxt's `submitBracket` verbatim in structure, including the failure
   * posture: on a thrown venue call the DB row STAYS at `submitting` (a
   * timeout after acceptance looks identical from here; `resolveSubmitting`
   * asks the venue later) while the in-memory entry goes, so a retry
   * re-issues the order and the venue's own client-order-id dedup settles it.
   */
  async submitEntry(order: NativeBracketRequest): Promise<BrokerAck> {
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) return this.ackFor(existing);

    const bracket: EmulatedBracket = {
      request: order,
      phase: 'submitting',
      entryOrderId: null,
      stopOrderId: null,
      targetOrderId: null,
      armedQty: null,
      armingQty: null,
      armAttempt: 0,
      inFlight: false,
      doubleFillAlerted: false,
      donePolling: false,
    };
    this.brackets.set(order.client_order_id, bracket);
    this.persist(bracket);

    let entry: AlpacaOrder;
    try {
      entry = await this.deps.call('submitBracket', () =>
        this.deps.client.submitLimitOrder({
          symbol: toAlpacaSymbol(order.instrument, order.asset_class),
          side: order.side,
          qty: String(order.size),
          limit_price: String(order.entry),
          // Pass-through: the Trader already sets crypto TIF to 'gtc'
          // (trader/types.ts DEFAULT config), which is one of the two values
          // Alpaca accepts for a crypto limit order ('gtc'/'ioc').
          time_in_force: order.time_in_force,
          client_order_id: order.client_order_id,
        }),
      );
    } catch (cause) {
      this.brackets.delete(order.client_order_id);
      throw cause;
    }

    bracket.phase = 'pending_entry';
    bracket.entryOrderId = entry.id;
    this.persist(bracket);

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [entry.id],
      order_state: mapOrderState(entry.status),
    };
  }

  /**
   * Under emulation only the entry exists at ack time; the leg ids appear
   * when the sweep arms them — reporting three ids up front would be
   * inventing two the venue has never heard of (ccxt's `ackFor`, unchanged).
   */
  private ackFor(bracket: EmulatedBracket): BrokerAck {
    return {
      client_order_id: bracket.request.client_order_id,
      broker_order_ids: this.brokerOrderIds(bracket.request.client_order_id),
      order_state: 'submitted',
    };
  }

  /**
   * The emulated re-arm (#525's seam, #586's crypto path): the same two
   * plain orders as an ordinary arm, sized to the residual, on a NEW arming
   * episode — `armAttempt` is bumped so the deterministic leg client order
   * ids cannot collide with an earlier episode's, and the claim (with the
   * quantity and the caller's stop/target folded into the journalled
   * request) is durable BEFORE any venue call, so a crash mid-re-arm resumes
   * through `resumeArming` exactly like a crash mid-first-arm.
   *
   * Refuses (throws — the caller turns that into the #525 fallback alert)
   * when no journalled bracket exists for this lot: with no row there is no
   * durable place to write the episode ahead, and an unjournalled arm is the
   * naked-crash-window this module exists to close.
   */
  async rearm(
    clientOrderId: string,
    _instrument: string,
    _side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) {
      throw new Error(
        `Alpaca crypto emulation cannot re-arm '${clientOrderId}': no journalled bracket exists ` +
          'for this lot, so the arming episode has no durable write-ahead home. The residual ' +
          "stays alert-only (ingest-fills' #525 fallback).",
      );
    }
    if (bracket.inFlight) {
      throw new Error(
        `Alpaca crypto emulation: bracket '${clientOrderId}' already has an arming episode in ` +
          'flight in this process; refusing to start a second.',
      );
    }

    // The claim. `stop`/`target` are folded into the journalled request —
    // the contract says they are the lot's own unchanged levels, but the
    // journal records what THIS episode will actually place, and recovery
    // re-places from the journal.
    bracket.request = { ...bracket.request, stop, target };
    bracket.phase = 'arming';
    bracket.armingQty = qty;
    bracket.armedQty = null;
    bracket.armAttempt += 1;
    bracket.inFlight = true;
    bracket.doubleFillAlerted = false;
    bracket.donePolling = false;
    this.persist(bracket);

    try {
      await this.retireStaleLegs(bracket);
      await this.armLegs(bracket, qty);
    } finally {
      bracket.inFlight = false;
    }
  }

  /**
   * Cancels the entry AND both emulated legs — the adapter's `cancel()` for
   * an owned bracket. There is no parent order whose cancellation takes
   * children with it here (that is the whole emulation), and cancelling only
   * the entry would leave a live stop resting against a position that no
   * longer exists — ccxt's `cancel` reasoning, unchanged.
   *
   * A throw from any cancel propagates BEFORE the phase write, so
   * `executeExit` refuses the flatten rather than market-ordering while it
   * is unknown whether the legs are gone — the same posture the adapter's
   * native `cancel` documents. The venue-side cancel itself is idempotent at
   * the transport (404/422 resolve).
   */
  async cancelAll(clientOrderId: string): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return;

    let entryId = bracket.entryOrderId;
    if (entryId === null) {
      // A `submitting` write-ahead: the venue may hold the entry under our
      // client order id even though no id was ever recorded.
      const order = await this.deps.call('cancel', () =>
        this.deps.client.getOrderByClientOrderId(clientOrderId),
      );
      entryId = order?.id ?? null;
    }

    for (const id of [entryId, bracket.stopOrderId, bracket.targetOrderId]) {
      if (id === null) continue;
      await this.deps.call('cancel', () => this.deps.client.cancelOrder(id));
    }

    bracket.phase = 'resolved';
    bracket.armingQty = null;
    // NOT `donePolling`: a leg may have filled in the race this cancel just
    // lost, and the next sweeps must still observe and book that fill.
    this.persist(bracket);
  }

  /**
   * One pass of the emulation, driven from the adapter's `fetchNewFills`:
   * poll every owned order, offer its fills (Alpaca-style — re-DERIVED from
   * the venue each poll, so no observed-fill queue is needed; `ingestFills`
   * dedups on `broker_fill_id`), then advance the phase machine one
   * transition per bracket. Per-bracket isolation and UnpricedFillError
   * bookkeeping match the adapter's own sweeps exactly — see
   * `fetchNewFills`'s comments for the full reasoning, which applies
   * unchanged here.
   *
   * Returns how many brackets failed this pass, for the caller's aggregate
   * error message.
   */
  async sweep(since: Date, fills: NormalizedFill[], failures: unknown[]): Promise<number> {
    let failed = 0;

    // Snapshot, for the same mid-iteration-mutation reason every other sweep
    // in this adapter snapshots.
    for (const bracket of [...this.brackets.values()]) {
      if (bracket.donePolling) continue;
      try {
        if (bracket.phase === 'submitting') {
          await this.resolveSubmitting(bracket);
          continue;
        }

        const entryId = bracket.entryOrderId;
        if (entryId === null) continue; // phase-machine bug; skipped like a malformed row
        const key = bracket.request.client_order_id;
        const instrument = bracket.request.instrument;

        const entry = await this.deps.call('fetchNewFills', () =>
          this.deps.client.getOrder(entryId),
        );
        collectFill(entry, 'entry', key, instrument, since, fills);

        const stopId = bracket.stopOrderId;
        const targetId = bracket.targetOrderId;
        const stopOrder =
          stopId === null
            ? null
            : await this.deps.call('fetchNewFills', () => this.deps.client.getOrder(stopId));
        if (stopOrder !== null) collectFill(stopOrder, 'stop', key, instrument, since, fills);
        const targetOrder =
          targetId === null
            ? null
            : await this.deps.call('fetchNewFills', () => this.deps.client.getOrder(targetId));
        if (targetOrder !== null) collectFill(targetOrder, 'target', key, instrument, since, fills);

        await this.watchDoubleFill(bracket, stopOrder, targetOrder, failures);

        if (bracket.phase === 'pending_entry') {
          await this.advanceEntry(bracket, entry);
        } else if (bracket.phase === 'arming') {
          await this.resumeArming(bracket);
        } else if (bracket.phase === 'armed') {
          await this.advanceExits(bracket, stopOrder, targetOrder);
        } else if (bracket.phase === 'cancelling_sibling') {
          await this.finishSiblingCancel(bracket, stopOrder, targetOrder);
        } else if (
          bracket.phase === 'resolved' &&
          isTerminal(entry) &&
          (stopOrder === null || isTerminal(stopOrder)) &&
          (targetOrder === null || isTerminal(targetOrder))
        ) {
          // Everything terminal and its fills just (re-)offered: nothing
          // left to observe until a restart re-derives once more.
          bracket.donePolling = true;
        }
      } catch (error) {
        // Same isolation, same UnpricedFillError bookkeeping (guarded journal
        // write, expected-condition-not-a-failure) as the adapter's bracket/
        // flatten/re-arm sweeps — see their comments.
        if (error instanceof UnpricedFillError) {
          try {
            this.deps.state.recordUnpricedFill('alpaca', error.observation, this.deps.clock.now());
          } catch (stateError) {
            failures.push(stateError);
            failed += 1;
          }
        } else {
          failures.push(error);
          failed += 1;
        }
      }
    }

    return failed;
  }

  /**
   * A write-ahead whose venue call never confirmed — ccxt's
   * `resolveSubmitting`, on Alpaca's client-order-id lookup. Null from the
   * venue is authoritative "never landed" (the transport maps only a genuine
   * 404 to null), so the row stops being reprocessed; a throw leaves it
   * `submitting` for the next poll.
   */
  private async resolveSubmitting(bracket: EmulatedBracket): Promise<void> {
    const order = await this.deps.call('resolveSubmitting', () =>
      this.deps.client.getOrderByClientOrderId(bracket.request.client_order_id),
    );

    if (order === null) {
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    bracket.phase = 'pending_entry';
    bracket.entryOrderId = order.id;
    this.persist(bracket);
  }

  /**
   * `pending_entry` → `arming` → `armed`, or → `resolved` if the entry died
   * empty. Arms when the entry goes TERMINAL with quantity: a fully-filled
   * entry arms at its size, and a partially-filled-then-cancelled/expired
   * entry arms at what actually filled — that residual is a live position
   * and leaving it naked because the entry died early would be the exact
   * failure this module exists to remove. A still-working entry (including
   * `partially_filled`) waits: legs are sized once, to the final quantity.
   */
  private async advanceEntry(bracket: EmulatedBracket, entry: AlpacaOrder): Promise<void> {
    // Claim check before any further await — ccxt's rule, kept even though
    // this sweep is the only driver today.
    if (bracket.phase !== 'pending_entry') return;

    const state = mapOrderState(entry.status);
    if (state === 'submitted' || state === 'partially_filled') return;

    const filledQty = Number.parseFloat(entry.filled_qty);
    if (!(filledQty > 0)) {
      // Terminal with nothing filled: no lot exists, nothing to protect.
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    // WRITE-AHEAD: `arming` (with the quantity this episode places for) is
    // durable BEFORE the first leg order — the crash there is recovered by
    // `resumeArming` in whatever process comes next.
    bracket.phase = 'arming';
    bracket.armingQty = filledQty;
    bracket.inFlight = true;
    this.persist(bracket);

    try {
      await this.armLegs(bracket, filledQty);
    } finally {
      bracket.inFlight = false;
    }
  }

  /** Finish an arming episode a previous process started — ccxt's `resumeArming`. */
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
   * Refuse-rather-than-guess recovery, ported intact from ccxt: an
   * inconclusive venue answer throws and leaves the bracket `arming` for the
   * next sweep (or an operator) rather than risking two live protective legs
   * on one lot.
   */
  private async recoverArming(bracket: EmulatedBracket): Promise<void> {
    const qty = bracket.armingQty;
    if (qty === null) {
      throw new Error(
        `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}' is 'arming' with ` +
          'no recorded arming quantity, so its protective legs cannot be sized. Refusing to ' +
          'guess a size for a live position; this bracket needs manual reconciliation.',
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
   * Kill legs recorded from an EARLIER episode before placing this one's —
   * live only on the re-arm path, where the previous episode's ids are still
   * on the record. A stale leg that FILLED means the lot exited while this
   * process was dead: refuse, exactly as ccxt did, rather than arm a fresh
   * pair over a position that may no longer exist.
   */
  private async retireStaleLegs(bracket: EmulatedBracket): Promise<void> {
    const { stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null && targetOrderId === null) return;

    const [stale, staleTarget] = await Promise.all([
      stopOrderId === null
        ? null
        : this.deps.call('fetchStaleStopStatus', () => this.deps.client.getOrder(stopOrderId)),
      targetOrderId === null
        ? null
        : this.deps.call('fetchStaleTargetStatus', () => this.deps.client.getOrder(targetOrderId)),
    ]);

    for (const [leg, order] of [
      ['stop', stale],
      ['target', staleTarget],
    ] as const) {
      if (order !== null && isFilled(order)) {
        throw new Error(
          `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}': a previous ` +
            `episode's ${leg} leg (${order.id}) filled while this bracket was mid-arm, so the ` +
            'lot has already exited. Refusing to arm a fresh protective pair; this bracket ' +
            'needs manual reconciliation against the venue.',
        );
      }
    }

    // Transport-idempotent cancels (404/422 resolve), so "already gone" costs
    // nothing while a genuine transport failure still throws out.
    await Promise.all(
      [stopOrderId, targetOrderId]
        .filter((id): id is string => id !== null)
        .map((id) => this.deps.call('cancelStaleLeg', () => this.deps.client.cancelOrder(id))),
    );

    bracket.stopOrderId = null;
    bracket.targetOrderId = null;
    this.persist(bracket);
  }

  /**
   * Adopt the leg the venue may already hold under this episode's
   * deterministic client order id, or place it — ccxt's recovery move, on
   * Alpaca's lookup. A working leg is adopted; a terminal one refuses (it
   * can be neither adopted as live protection nor re-placed under the same
   * id); an absent one is placed.
   */
  private async adoptOrPlaceLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<AlpacaOrder> {
    const legClientOrderId = this.legClientOrderId(bracket, leg);
    const existing = await this.deps.call(
      leg === 'stop' ? 'fetchStopLegByClientId' : 'fetchTargetLegByClientId',
      () => this.deps.client.getOrderByClientOrderId(legClientOrderId),
    );

    if (existing === null) return this.placeLeg(bracket, leg, qty);
    const state = mapOrderState(existing.status);
    if (state === 'submitted' || state === 'partially_filled') return existing;

    throw new Error(
      `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}': the ${leg} leg ` +
        `'${legClientOrderId}' exists at the venue in terminal state '${existing.status}', so ` +
        'it can be neither adopted as live protection nor re-placed under the same client ' +
        'order id. Refusing to report this lot as armed; it needs manual reconciliation.',
    );
  }

  /** Places both legs sized to `qty` — never the requested size (spec story 13). */
  private async armLegs(bracket: EmulatedBracket, qty: number): Promise<void> {
    const [stop, target] = await Promise.all([
      this.placeLeg(bracket, 'stop', qty),
      this.placeLeg(bracket, 'target', qty),
    ]);

    this.landArmed(bracket, stop.id, target.id, qty);
  }

  private async placeLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<AlpacaOrder> {
    const { request } = bracket;
    // The CLOSING side. `request.side` is the lot's opening/held side both on
    // the first arm and on a re-arm (the re-arm contract passes the HELD
    // side, which is the same side).
    const exitSide = request.side === 'buy' ? 'sell' : 'buy';
    const symbol = toAlpacaSymbol(request.instrument, request.asset_class);
    const clientOrderId = this.legClientOrderId(bracket, leg);

    if (leg === 'stop') {
      return this.deps.call('armStopLeg', () =>
        this.deps.client.submitStopLimitOrder({
          symbol,
          side: exitSide,
          qty: String(qty),
          stop_price: String(request.stop),
          // The caller computes ONE stop level (`NativeBracketRequest.stop`);
          // crypto has no plain stop type, so the required post-trigger limit
          // is set AT the stop level. The honest cost: a market that gaps
          // through the stop can leave this limit unfilled — the same
          // trade-off any stop-limit carries, chosen over inventing a
          // slippage allowance the caller never priced.
          limit_price: String(request.stop),
          time_in_force: 'gtc',
          client_order_id: clientOrderId,
        }),
      );
    }

    return this.deps.call('armTargetLeg', () =>
      this.deps.client.submitLimitOrder({
        symbol,
        side: exitSide,
        qty: String(qty),
        limit_price: String(request.target),
        // 'gtc' on both legs regardless of the entry's TIF: a protective leg
        // must rest until it fires or is cancelled, and 'gtc' is one of the
        // two values Alpaca accepts for crypto.
        time_in_force: 'gtc',
        client_order_id: clientOrderId,
      }),
    );
  }

  /**
   * Deterministic per-episode leg ids — ccxt's scheme unchanged: within one
   * episode the venue's duplicate-client-order-id rejection is the recovery
   * safety net, across episodes a fresh suffix avoids it.
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
   * The OCO edge, kept by hand: one leg observed filled → journal
   * `cancelling_sibling` → cancel the sibling → `resolved`. The claim and
   * the journal write are synchronous, so the edge is taken exactly once; a
   * thrown cancel leaves `cancelling_sibling` durable and the next sweep
   * (`finishSiblingCancel`) retries — unlike ccxt, which resolved first and
   * accepted an orphaned sibling on a throw. Both-filled resolves with
   * nothing to cancel; `watchDoubleFill` has already escalated it.
   */
  private async advanceExits(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
  ): Promise<void> {
    if (bracket.phase !== 'armed') return;
    const stopFilled = stopOrder !== null && isFilled(stopOrder);
    const targetFilled = targetOrder !== null && isFilled(targetOrder);
    if (!stopFilled && !targetFilled) return;

    if (stopFilled && targetFilled) {
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    const siblingId = stopFilled ? bracket.targetOrderId : bracket.stopOrderId;
    // Journalled BEFORE the venue call it commits to — the module's one rule.
    bracket.phase = 'cancelling_sibling';
    this.persist(bracket);

    if (siblingId !== null) {
      await this.deps.call('cancelSibling', () => this.deps.client.cancelOrder(siblingId));
    }

    bracket.phase = 'resolved';
    this.persist(bracket);
  }

  /**
   * Resume a sibling cancel the journal says is owed — after a crash, or
   * after `advanceExits`'s own cancel threw. Cancels every leg not observed
   * filled (the venue cancel is transport-idempotent, so re-cancelling one
   * already gone costs nothing), then resolves. If BOTH have filled by now,
   * there is nothing left to cancel and `watchDoubleFill` has escalated.
   */
  private async finishSiblingCancel(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
  ): Promise<void> {
    if (bracket.phase !== 'cancelling_sibling') return;

    for (const [id, order] of [
      [bracket.stopOrderId, stopOrder],
      [bracket.targetOrderId, targetOrder],
    ] as const) {
      if (id === null) continue;
      if (order !== null && isFilled(order)) continue;
      await this.deps.call('cancelSibling', () => this.deps.client.cancelOrder(id));
    }

    bracket.phase = 'resolved';
    this.persist(bracket);
  }

  /**
   * The accepted-risk watcher: BOTH legs reporting filled is the double-fill
   * window materialised (see the module doc). Detection is re-derived from
   * venue state each sweep and gated by a process-local flag, so a failed
   * delivery is retried next sweep and a restart re-alerts at most once —
   * noisy, never silent. The channel's own error is read and discarded
   * (`BrokerError`'s posture: transport failures quote requests that carry
   * tokens); a named replacement joins `failures` instead.
   */
  private async watchDoubleFill(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
    failures: unknown[],
  ): Promise<void> {
    if (bracket.doubleFillAlerted) return;
    if (stopOrder === null || targetOrder === null) return;
    if (!isFilled(stopOrder) || !isFilled(targetOrder)) return;

    try {
      await this.deps.doubleFillAlerts.postOcoDoubleFillAlert({
        client_order_id: bracket.request.client_order_id,
        instrument: bracket.request.instrument,
        stop_order_id: stopOrder.id,
        target_order_id: targetOrder.id,
        observed_at: this.deps.clock.now(),
      });
      bracket.doubleFillAlerted = true;
    } catch {
      failures.push(
        new Error(
          `Alpaca crypto emulation: double-fill alert delivery failed for ` +
            `'${bracket.request.client_order_id}' — both protective legs report filled and the ` +
            'operator has not been told; delivery will be retried next sweep',
        ),
      );
    }
  }
}

/** Fully filled at the venue — the only state that takes the OCO edge. */
function isFilled(order: AlpacaOrder): boolean {
  return mapOrderState(order.status) === 'filled' && Number.parseFloat(order.filled_qty) > 0;
}

/** Any state the venue will never change again. */
function isTerminal(order: AlpacaOrder): boolean {
  const state = mapOrderState(order.status);
  return state !== 'submitted' && state !== 'partially_filled';
}
