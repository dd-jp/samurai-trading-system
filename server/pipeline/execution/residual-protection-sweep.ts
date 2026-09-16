/**
 * Durable, cadence-driven retry for a partial-flatten residual whose
 * protective legs were never CONFIRMED re-armed.
 *
 * The observing poll's re-arm fires only when it directly witnesses the
 * residual, and the venue's fill feed does not re-offer that fill forever —
 * so a crash between the exit fill persisting and the re-arm confirming (or
 * a re-arm failure the process survives) would otherwise leave the residual
 * naked with no retry. This sweep is the alternative to a retry loop on the
 * order-submitting path: a durable marker, written the moment the residual is
 * first known, checked idempotently until cleared.
 *
 * Wired from both `reconcile()` (covers a crash — restart finds the marker)
 * and `startFillSync`'s poll loop (covers a re-arm failure the process
 * survived, since there is no recurring `reconcile()` schedule otherwise).
 * Cheap when healthy: an empty worklist makes no broker call.
 *
 * A retry must tolerate a re-arm that actually SUCCEEDED venue-side before a
 * crash lost its confirmation — every adapter's `rearmProtectiveLegs` is
 * itself idempotent (adopt-or-place, or re-set the same protected quantity),
 * so the sweep retries through the SAME broker seam the observing poll uses.
 *
 * A marker whose retry FAILS pages `ResidualExposureAlertChannel` once per
 * unprotected EPISODE, not once per pass — deduped by a durable `alerted_at`
 * on the marker. One retry before paging, deliberately: a naked residual is
 * live exposure, waiting more sweeps buys nothing, and a retry that would
 * have succeeded anyway clears the marker and the operator also learns it
 * happened.
 *
 * Some venues/lots can never re-arm at all (Saxo lacks OCO support; Alpaca
 * exhausts its re-arm wire-id budget per lot) — `protective-rearm-unsupported.ts`
 * is what this sweep branches on. In that case the residual is CLOSED rather
 * than protected: `reflattenResidual` submits a bounded, session-gated market
 * order, and only when that stands down or fails does this pass page. This
 * sweep runs after `ingestFills` has swept the originating flatten's fills,
 * so it — unlike the observing poll — can tell "the daily flatten is still in
 * flight" from "it finished and left this residual behind".
 *
 * The exposure is still bounded by ADR-0014's flat-by-close, but only within
 * the flatten window; past that grace the residual is carried overnight
 * unprotected and the carried-lot alert is what makes that audible. This
 * sweep's own re-flatten is not bound by that window — it fires on any pass
 * while the venue is open.
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
import { reflattenResidual } from './residual-reflatten.js';
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
      // Outer boundary for `sweepOne`'s success-path writes (confirm/alert
      // dedup). The marker's own durability is the recovery: the row stays
      // marked and the next pass retries it.
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
        // `describeThrownSafely`, not the raw error: this render sits inside a
        // per-lot catch inside the `for` loop above, so a value whose
        // `message`/`toString` throws would abort the WHOLE pass and leave
        // every later marked lot naked — the one thing this loop's
        // containment exists to prevent.
        reason: `residual-protection sweep failed: ${describeThrownSafely(error)}`,
        escalation: 'residual_sweep_lot_unsettled',
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
    // The exact residual is unknowable without this read; alert with the
    // upper bound instead, since over-stating what is at risk is the
    // conservative direction for an operator. Marker stays.
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
      escalation: 'residual_sweep_size_read_failed',
    };
  }

  // Entry fill still outstanding: nothing open to protect yet, nothing to
  // report — the marker stays for the pass after the entry lands.
  if (filledSize === 0) return null;

  // Flat by the persisted record: a later fill closed the residual, so
  // "not yet confirmed protected" is moot. Clearing here makes the sweep
  // a no-op once the position is gone.
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

  // Fail-closed: a garbage residual while `isFlat` says "not flat" is a store
  // divergence to surface, never a quantity to hand the broker or the
  // operator (NaN serializes to null in the page payload) — alert with the
  // upper-bound `requested_size` instead, same shape as the read-failure path
  // above. The divergence reason below still names the real value for
  // diagnosis.
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
      escalation: 'residual_sweep_garbage_residual',
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
    // A permanent gap is not a failed retry: where an ordinary failure is
    // retried on the next pass, this one is REPLACED — the residual is
    // closed rather than protected, below.
    const unsupported = isProtectiveRearmUnsupported(error);
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
              'sweepResidualProtection: arming protective legs for this lot is permanently ' +
              'refused, so no pass of this sweep can protect it — the marker stays and only ' +
              'manual action at the venue clears it',
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

    // This sweep is the cadence that owns the close-instead-of-protect
    // remedy: by the time a pass reads a marked lot, `ingestFills` has
    // already swept the originating flatten's fills, so the journal gate in
    // `reflattenResidual` can tell "the daily flatten is still in flight"
    // from "it is done and left this residual behind" — which the observing
    // poll, running with its own flatten row still unswept, cannot.
    if (unsupported) {
      const reflatten = await reflattenResidual(input, position, residual, now);
      // A pass that finds THIS lot's own re-flatten still working is the same
      // state as the pass that sent it — the residual is being closed — so it
      // suppresses the page for the same reason. Paging here would say
      // "could not be closed" of a lot with a live closing order, and its
      // remedy (manual venue action) would be a third submitter.
      if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') {
        return {
          idempotency_key: key,
          instrument: position.instrument,
          store_state: position.order_state,
          broker_state: null,
          action: 'undetermined',
          kind: 'sweep',
          reason: reflatten.detail,
          escalation: 'residual_sweep_reflatten_in_flight',
        };
      }
      if (reflatten.kind === 'submitted') {
        // No page: the residual is being CLOSED, and the marker stays until
        // the fill lands and the lot reads flat (the `isFlat` branch above).
        // If the order does not close it, the next pass lands here again and
        // pages once the attempt budget is spent.
        return {
          idempotency_key: key,
          instrument: position.instrument,
          store_state: position.order_state,
          broker_state: null,
          action: 'undetermined',
          kind: 'sweep',
          reason:
            `this lot can never be re-armed, so residual ${residual} was CLOSED instead ` +
            `(#1214): market order '${reflatten.idempotency_key}' is live at the venue and the ` +
            'marker clears when its fill lands',
          escalation: 'residual_sweep_reflatten_submitted',
        };
      }
    }

    await alertResidualExposureOnce(input, row, residual, now, { rearmUnsupported: unsupported });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: unsupported
        ? `this lot can never be re-armed and the residual ${residual} could not ` +
          `be closed either — see the residual_reflatten_* log line for which gate stood the ` +
          `re-flatten down: ${describeThrownSafely(error)}`
        : `re-arm retry failed for residual ${residual}: ${describeThrownSafely(error)}`,
      // Two escalation values for one push site, not one: `unsupported` is
      // `sweepOne`'s own permanent-vs-retryable distinction (this file's
      // "no pass can ever re-arm" doc), and a failing lot's ordinary retries
      // exhaust its re-arm budget and land here `unsupported` on a LATER
      // pass — a shared value would dedup that transition away as "same
      // state" (#1615), collapsing a page-worthy permanent gap into the
      // retryable line a prior pass already logged
      escalation: unsupported
        ? 'residual_sweep_rearm_unsupported'
        : 'residual_sweep_rearm_retry_failed',
    };
  }

  // CONFIRMED — the broker call resolved (venue-acked or adopted), which is
  // the only thing that may clear the marker. Runs OUTSIDE the try above so
  // a confirm-write failure is the outer containment's `undetermined` (and
  // the next pass's idempotent re-verify), never mistaken for a re-arm
  // failure
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
 * ORDERING (#549 review, cycle 2; dedup split #1447): TWO independent
 * durable dedups back this function — `row.alerted_at` /
 * `markResidualAlerted` (`residual_rearm_alerted_at`) for every pre-attempt
 * or ordinary-retry page (store-read failure, non-finite residual, an
 * ordinary retryable re-arm failure), and `row.rearm_unsupported_alerted_at`
 * / `markResidualRearmUnsupportedAlerted` (`residual_rearm_unsupported_alerted_at`)
 * for the TRUTHFUL permanent-gap page — a CONFIRMED venue refusal
 * (`flags.rearmUnsupported: true`, only ever set by the caller in `sweepOne`
 * right after `isProtectiveRearmUnsupported` returned true). `flags.rearmUnsupported`
 * below picks which pair `dedup` reads from and writes to; the two never
 * cross, which is what stops a pre-attempt page from ever consuming the one
 * page a permanent gap needs — the defect #1447 was filed against.
 *
 * Each pair reads the pass-start worklist snapshot (`row.alerted_at` /
 * `row.rearm_unsupported_alerted_at`), and each `mark*` write is CONDITIONAL
 * (first-writer-wins on its own column `IS NULL`, reporting whether this
 * call won), so each durable dedup holds regardless of which alert surface
 * runs first or in what order. The two surfaces cannot actually interleave
 * in-process today — `runStartupReconcile` is awaited before `startFillSync`
 * ever arms its first timer (production.ts `start()`), and within the
 * fill-sync loop `runPoll` awaits `ingestFills` (the inline alert path)
 * before the sweep, under an `inFlight` guard that serializes passes — so a
 * lost race is a composition change away, not a live behaviour; the
 * conditional write is the durable backstop that keeps each record
 * single-writer even then. In the worst interleave the page itself could go
 * out twice (delivery precedes the claim, deliberately — claim-first would
 * re-create the suppressed-page bug the delivery gate above closes); the
 * RECORD never does.
 */
async function alertResidualExposureOnce(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
  residualQty: number,
  now: Date,
  flags: ResidualExposureFlags,
): Promise<void> {
  const dedup = flags.rearmUnsupported
    ? {
        alreadyAlerted: row.rearm_unsupported_alerted_at !== null,
        record: (key: string, at: Date) => input.store.markResidualRearmUnsupportedAlerted(key, at),
        failureMessage:
          'markResidualRearmUnsupportedAlerted failed — the next sweep pass may page a second ' +
          'time for a permanent gap that was already alerted (noisy, not unsafe; #1447)',
      }
    : {
        alreadyAlerted: row.alerted_at !== null,
        record: (key: string, at: Date) => input.store.markResidualAlerted(key, at),
        failureMessage:
          'markResidualAlerted failed — the next sweep pass may page a second time for an ' +
          'episode that was already alerted (noisy, not unsafe)',
      };

  if (dedup.alreadyAlerted) return;
  const delivered = await alertResidualExposure(input, row.position, residualQty, now, flags);
  if (!delivered) return;
  try {
    const recorded = await dedup.record(row.position.idempotency_key, now);
    if (!recorded) {
      // Another surface recorded the episode's page between this pass's
      // worklist snapshot and now — the durable dedup already held, this
      // pass's page was the (worst-case) duplicate the doc above accepts
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
        message: dedup.failureMessage,
      },
      error,
      { idempotency_key: row.position.idempotency_key },
    );
  }
}
