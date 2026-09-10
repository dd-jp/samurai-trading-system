/**
 * The #549 residual-protection sweep — the durable, cadence-driven retry for
 * a partial-flatten residual whose protective legs were never CONFIRMED
 * re-armed.
 *
 * ## Why this exists
 *
 * `ingestFills()`'s #525 re-arm fires only on the poll that OBSERVES the
 * residual — both of its triggers (`ingestedExit`, `flattenTargetedThisPoll`)
 * are poll-scoped, and the venue's fill feed does not re-offer forever
 * (`AlpacaBrokerAdapter` prunes a flatten's order after the poll that offers
 * its fill). A crash between the exit fill persisting and the re-arm
 * confirming — or a re-arm failure the process survives — therefore left the
 * residual naked indefinitely, with no retry and (in the crash case) no
 * alert, because the fallback alert lives inside the attempt that never runs
 * again. The recorded #525 decision rejected a retry LOOP on the
 * order-submitting poll path; this sweep is the accepted alternative — a
 * durable marker (migration 0024, written by `residual-protection.ts` the
 * moment the residual is first known) checked idempotently on an ongoing basis.
 *
 * ## When it runs
 *
 * Twice-wired, mirroring #603's flatten-journal sweep:
 *
 * - `reconcile()` calls it (reconcile.ts) — startup and any future reconcile
 *   cadence, which is what covers a crash: the restarted process's first
 *   reconcile finds the marker and retries.
 * - `startFillSync`'s poll loop calls it (orchestrator/fill-sync.ts) via
 *   `Execution.sweepResidualProtection` — the WITHIN-PROCESS cadence, which
 *   is what covers a re-arm failure the process survived: this codebase has
 *   no recurring `reconcile()` schedule today (fill-sync.ts's file doc), so
 *   without this leg the retry would wait for the next restart.
 *
 * Cheap when healthy: `getUnprotectedResidualLots()` returns nothing, and
 * the sweep makes no broker call at all.
 *
 * ## Idempotency
 *
 * A retry must tolerate a re-arm that actually SUCCEEDED venue-side before a
 * crash lost its confirmation. Every `rearmProtectiveLegs` path does:
 * equities adopt-or-place on the deterministic `:rearm` wire id
 * (`AlpacaBrokerAdapter`, the #600/#603 posture); the crypto emulation
 * retires its previous episode's legs before arming a fresh journalled
 * episode (`AlpacaCryptoLegEmulation.rearm`); the Simulated adapter re-sets
 * the same protected quantity. So the sweep retries through the SAME broker
 * seam the observing poll uses, and "confirmed" means exactly what it means
 * there: the call resolved.
 *
 * ## Escalation
 *
 * A marker whose sweep retry FAILS pages `ResidualExposureAlertChannel` —
 * from the sweep, not only the observing poll — once per unprotected
 * EPISODE, not once per pass (#342's repeated-line lesson): the dedup is the
 * durable `alerted_at` on the marker itself, set by whichever surface alerts
 * first and cleared only with the marker. N = 1 retry before paging,
 * deliberately: a naked residual is live venue exposure, waiting more sweeps
 * buys nothing, and a retry that would have succeeded on pass 2 clears the
 * marker then anyway — the operator just also knows it happened. Every
 * attempt, alerted or not, still leaves a trace: failures via
 * `logCaughtFailure` (#608), outcomes via the `ReconcileDivergence`s this
 * returns, which both callers log per entry.
 *
 * ## When the venue can never re-arm at all (#1214)
 *
 * The Idempotency section above lists three adapters that CAN re-arm. Saxo
 * cannot: every LSE pool line reports `IsOcoOrderSupported: false` (doc 43),
 * so an entry-less stop+target pair is inexpressible and
 * `SaxoBrokerAdapter.rearmProtectiveLegs` refuses before it reaches the
 * venue (`ProtectiveRearmUnsupportedError`). This sweep still retries it on
 * every pass — deliberately: a venue capability is re-read on each attempt
 * rather than cached here, an operator who re-arms by hand is not helped by
 * this loop giving up, and the attempt costs no venue call. What changes is
 * the REPORT: the log line, the divergence reason and the page all say the
 * gap is permanent, because "retry failed" trains an operator to wait for a
 * pass that can never succeed.
 *
 * That leaves the alert as the only remedy on such a venue, which is a
 * position #1214 records rather than one this file chooses — the two
 * mechanical alternatives it lists (a hand-emulated OCO carrying #586's
 * double-fill race, or re-flattening the residual instead of protecting it)
 * both change what the system DOES with live money and are the owner's call.
 *
 * The bound on the exposure meanwhile is ADR-0014's flat-by-close, and it is a
 * bound with a stated edge rather than a guarantee. A marked lot is still an
 * open position, so `buildExitIntent` (trader/decide.ts) targets it like any
 * other — but only on a TICK inside the flatten window, which runs from
 * `flatten_before_close_ms` before the close to `flatten_after_close_ms` after
 * it (#1389). Past that grace nothing targets the lot again until the next
 * session's window, and the residual is carried overnight unprotected; the
 * carried-lot alert (`orchestrator/production/carried-lot-alert.ts`) is what
 * makes that outcome audible.
 *
 * This paragraph previously said the flatten targeted such a lot "in the
 * flatten window like any other" with no edge stated, which read as an
 * unconditional bound. It was worse than incomplete before #1389: the window
 * was forward-only, so once the close had passed there was no instant at which
 * a flatten could be produced at all, and the sentence was describing a remedy
 * that could not run.
 */

import {
  describeThrownSafely,
  heldQuantityFromFills,
  isFlat,
  logCaughtFailure,
  safeLog,
} from '../../shared/index.js';
import { isProtectiveRearmUnsupported } from './protective-rearm-unsupported.js';
import { alertResidualExposure, type ResidualExposureFlags } from './residual-protection.js';
import type {
  ReconcileDivergence,
  ResidualProtectionSweepResult,
  ResidualSweepInput,
  UnprotectedResidualLot,
} from './types.js';

/**
 * One sweep pass over every marked lot. Never rejects for a single lot's
 * failure — each lot is independent work under its own containment
 * (`ingestFills`' own `ContainedFailure` reasoning), reported as an
 * `undetermined` divergence rather than a thrown error, because a durable
 * cause (a corrupt row, a venue outage) would otherwise abort every LATER
 * marked lot on every pass, indefinitely. Only the worklist read itself may
 * reject — with no worklist there is no pass, the same way `reconcile()`
 * treats `getUnresolvedFlattens()`.
 */
export async function sweepResidualProtection(
  input: ResidualSweepInput,
): Promise<ResidualProtectionSweepResult> {
  const marked = await input.store.getUnprotectedResidualLots();
  const divergences: ReconcileDivergence[] = [];

  for (const row of marked) {
    try {
      const divergence = await sweepOne(input, row);
      if (divergence !== null) divergences.push(divergence);
    } catch (error) {
      // `sweepOne` handles its own known failure modes; this catch is the
      // outer boundary for the writes it makes on its success paths (the
      // confirm/alert-dedup store writes). The marker's own durability is
      // the recovery: whatever failed, the row is still marked and the next
      // pass retries it.
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'residual_sweep_lot_unsettled',
          level: 'error',
          message:
            'sweepResidualProtection: one marked lot could not be settled this pass — the ' +
            'marker stays and the next pass retries',
        },
        error,
        { idempotency_key: row.position.idempotency_key },
      );
      divergences.push({
        idempotency_key: row.position.idempotency_key,
        instrument: row.position.instrument,
        store_state: row.position.order_state,
        broker_state: null,
        action: 'undetermined',
        kind: 'sweep',
        // An IDENTIFIER-only message plus the error's own text. On CREDENTIALS
        // that is `reconcileLot`'s reason: #297's H1 has every adapter convert
        // what its client threw into a curated `BrokerError` before it is
        // visible, and store errors are this codebase's own curated messages.
        // On RENDERING it is not — see `describeThrownSafely`'s doc and #1262:
        // this render sits inside a per-lot catch inside the `for` loop above,
        // so a value whose `message`/`toString` throws would abort the WHOLE
        // pass here and leave every later marked lot naked, which is the one
        // thing this loop's containment exists to prevent.
        reason: `residual-protection sweep failed: ${describeThrownSafely(error)}`,
      });
    }
  }

  return { checked: marked.length, divergences };
}

/**
 * Settle one marked lot. Recomputes the residual off the persisted fill
 * record fresh — never off the marker's age or any cached figure — with the
 * SAME expressions the observing poll uses (`heldQuantityFromFills`/`isFlat`,
 * shared/held-quantity.ts), so the two surfaces cannot disagree about flatness.
 */
async function sweepOne(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
): Promise<ReconcileDivergence | null> {
  const { broker, store, clock } = input;
  const { position } = row;
  const key = position.idempotency_key;
  const now = clock.now();

  let filledSize: number;
  let exitQty: number;
  try {
    ({ filledSize, exitQty } = heldQuantityFromFills(await store.getFills(key)));
  } catch (error) {
    // The exact residual is unknowable without this read — the same
    // upper-bound escalation `maybeRearmResidual`'s own store-read catch
    // takes (#569's flag), because the conservative direction for an
    // operator is over-stating what is at risk. Marker stays.
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_size_read_failed',
        level: 'error',
        message:
          'sweepResidualProtection: store read failed while recomputing a marked residual — ' +
          'alerting with the upper-bound requested_size instead',
      },
      error,
      { idempotency_key: key },
    );
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: `marked residual could not be recomputed (fill read failed): ${describeThrownSafely(
        error,
      )}`,
    };
  }

  // Entry fill still outstanding: nothing open to protect yet, nothing to
  // report — the marker stays for the pass after the entry lands.
  if (filledSize === 0) return null;

  // Flat by the persisted record: the residual is gone (a later fill closed
  // it), so "not yet confirmed protected" is settled — there is nothing left
  // to protect. Clearing here is what makes crash window (d) a no-op sweep.
  if (isFlat({ filledSize, exitQty })) {
    await store.confirmResidualProtected(key);
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'adopted',
      kind: 'sweep',
      reason:
        'marked lot reads flat on the persisted fill record — nothing left unprotected; ' +
        'residual-protection marker cleared',
    };
  }

  const residual = filledSize - exitQty;

  // Fail-closed, `maybeRearmResidual`'s own guard verbatim: a garbage
  // residual while `isFlat` says "not flat" is a store divergence to
  // surface, never a quantity to hand the broker — and never a quantity to
  // hand the OPERATOR either (#549 review, round 3): NaN serializes to null
  // in the page payload and a negative reads as nonsense, so the alert
  // carries the upper-bound `requested_size` with the upper-bound flag, the
  // same shape as the fill-read-failure path above. The divergence reason
  // below still names the real recomputed value for diagnosis.
  if (!(residual > 0) || !Number.isFinite(residual)) {
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason:
        `marked residual recomputes to ${residual} (non-finite or non-positive) while the fill ` +
        'record reads not-flat — refusing to re-arm a garbage quantity; check the store by hand',
    };
  }

  try {
    await broker.rearmProtectiveLegs(
      key,
      position.instrument,
      position.side,
      residual,
      position.stop,
      position.target,
    );
  } catch (error) {
    // #1214: separated from an ordinary failure, and ONLY in what is
    // reported. The retry itself is unchanged — see the file doc's
    // permanent-gap section for why this pass does not stop attempting.
    const unsupported = isProtectiveRearmUnsupported(error);
    // Every attempt leaves a trace (#608); the PAGE is once per episode —
    // see the file doc's escalation section.
    logCaughtFailure(
      input.logger,
      // Two whole entries rather than one with a conditional `event`: every
      // logged code must be a bare snake_case literal, greppable from the
      // source (`log-event-code.test.ts`).
      unsupported
        ? {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_unsupported',
            level: 'error',
            message:
              'sweepResidualProtection: this venue cannot arm protective legs at all, so no ' +
              'pass of this sweep can protect the lot — the marker stays and only manual ' +
              'action at the venue clears it',
          }
        : {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_failed',
            level: 'error',
            message:
              'sweepResidualProtection: broker.rearmProtectiveLegs retry failed — the marker ' +
              'stays and the next pass retries',
          },
      error,
      { idempotency_key: key, residual_qty: residual },
    );
    await alertResidualExposureOnce(input, row, residual, now, { rearmUnsupported: unsupported });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: unsupported
        ? `this venue cannot arm protective legs at all, so residual ${residual} stays naked ` +
          `until an operator acts at the venue: ${describeThrownSafely(error)}`
        : `re-arm retry failed for residual ${residual}: ${describeThrownSafely(error)}`,
    };
  }

  // CONFIRMED — the broker call resolved (venue-acked or adopted), which is
  // the only thing that may clear the marker. Runs OUTSIDE the try above so
  // a confirm-write failure is the outer containment's `undetermined` (and
  // the next pass's idempotent re-verify), never mistaken for a re-arm
  // failure.
  await store.confirmResidualProtected(key);
  return {
    idempotency_key: key,
    instrument: position.instrument,
    store_state: position.order_state,
    broker_state: null,
    action: 'adopted',
    kind: 'sweep',
    reason:
      `protective legs re-armed for residual ${residual} by the #549 sweep — ` +
      'residual-protection marker cleared',
  };
}

/**
 * The once-per-episode escalation — posts `ResidualExposureAlertChannel`
 * (through `alertResidualExposure`'s swallow/CREDENTIALS posture, unchanged)
 * only when this episode has never alerted, then records the dedup durably.
 * A suppressed duplicate is not silent: every suppressing pass still emits
 * its `undetermined` divergence, which both callers log.
 *
 * The dedup is recorded ONLY when the channel accepted the delivery (#549
 * review — `alertResidualExposure`'s boolean): a swallowed transport outage
 * must leave the episode un-alerted, so the NEXT pass pages again instead of
 * the one failed attempt permanently silencing the only page for a
 * still-naked residual.
 *
 * ORDERING (#549 review, cycle 2): `row.alerted_at` is the pass-start
 * worklist snapshot, and `markResidualAlerted` is CONDITIONAL
 * (first-writer-wins on `residual_rearm_alerted_at IS NULL`, reporting
 * whether this call won), so the durable dedup holds regardless of which
 * alert surface runs first or in what order. The two surfaces cannot
 * actually interleave in-process today — `runStartupReconcile` is awaited
 * before `startFillSync` ever arms its first timer (production.ts
 * `start()`), and within the fill-sync loop `runPoll` awaits `ingestFills`
 * (the inline alert path) before the sweep, under an `inFlight` guard that
 * serializes passes — so a lost race is a composition change away, not a
 * live behaviour; the conditional write is the durable backstop that keeps
 * the record single-writer even then. In the worst interleave the page
 * itself could go out twice (delivery precedes the claim, deliberately —
 * claim-first would re-create the suppressed-page bug the delivery gate
 * above closes); the RECORD never does.
 */
async function alertResidualExposureOnce(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
  residualQty: number,
  now: Date,
  flags: ResidualExposureFlags,
): Promise<void> {
  if (row.alerted_at !== null) return;
  const delivered = await alertResidualExposure(input, row.position, residualQty, now, flags);
  if (!delivered) return;
  try {
    const recorded = await input.store.markResidualAlerted(row.position.idempotency_key, now);
    if (!recorded) {
      // Another surface recorded the episode's page between this pass's
      // worklist snapshot and now — the durable dedup already held, this
      // pass's page was the (worst-case) duplicate the doc above accepts.
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        level: 'info',
        message:
          "residual-exposure page dedup was already held by another surface — this pass's page " +
          'was a duplicate; the durable record stays single-writer',
        payload: { idempotency_key: row.position.idempotency_key },
      });
    }
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_alert_mark_failed',
        level: 'warn',
        message:
          'markResidualAlerted failed — the next sweep pass may page a second time for an ' +
          'episode that was already alerted (noisy, not unsafe)',
      },
      error,
      { idempotency_key: row.position.idempotency_key },
    );
  }
}
