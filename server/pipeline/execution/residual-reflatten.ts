
import type { OpenPosition } from '../../shared/index.js';
import { describeThrownSafely, logCaughtFailure, safeLog } from '../../shared/index.js';
import { UnresolvedFlattenForInstrumentError } from './sqlite-shared-store.js';
import type { ResidualReflattenInput } from './types.js';

export const MAX_RESIDUAL_REFLATTEN_ATTEMPTS = 3;

type ResidualReflattenSkipReason =
  | 'venue_shut'
  | 'session_unknown'
  | 'flatten_in_flight'
  | 'own_reflatten_in_flight'
  | 'journal_read_failed'
  | 'attempts_exhausted';

export type ResidualReflattenOutcome =
  | { kind: 'submitted'; idempotency_key: string; qty: number }
  | { kind: 'skipped'; reason: ResidualReflattenSkipReason; detail: string }
  | { kind: 'failed'; detail: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each early return is a distinct, named skip/fail/stand-down outcome the doc comments justify individually, and the write-ahead-before-broker-call ordering is mandatory (see the comment above `writeAheadFlatten`) — extracting a branch risks separating a return from the specific evidence it is conditioned on
export async function reflattenResidual(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  now: Date,
): Promise<ResidualReflattenOutcome> {
  const { store, broker } = input;
  const lotKey = position.idempotency_key;

  let open: boolean;
  try {
    open = input.sessionCalendars[position.asset_class].isOpen(now);
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'session_unknown',
      `the ${position.asset_class} calendar could not answer whether the venue is open: ` +
        describeThrownSafely(error),
    );
  }
  if (!open) {
    return skip(
      input,
      position,
      residual,
      'venue_shut',
      'the venue is shut at this instant — the residual stays naked until the next session, ' +
        'the same bound the daily flatten works to',
    );
  }

  let unresolved: readonly { instrument: string; idempotency_key: string }[];
  try {
    unresolved = await store.getUnresolvedFlattens();
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'journal_read_failed',
      `getUnresolvedFlattens failed, so an in-flight flatten could not be ruled out: ${describeThrownSafely(
        error,
      )}`,
    );
  }
  const onInstrument = unresolved.filter((row) => row.instrument === position.instrument);
  const blocking =
    onInstrument.find((row) => isOwnReflattenKey(row.idempotency_key, lotKey)) ?? onInstrument[0];
  if (blocking !== undefined) {
    return standDown(input, position, residual, lotKey, blocking.idempotency_key);
  }

  let candidate: string | null;
  try {
    candidate = await resolveReflattenKey(input, lotKey);
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'journal_read_failed',
      `findByKey failed while counting this lot's earlier re-flatten attempts: ${describeThrownSafely(
        error,
      )}`,
    );
  }
  if (candidate === null) {
    return skip(
      input,
      position,
      residual,
      'attempts_exhausted',
      `${MAX_RESIDUAL_REFLATTEN_ATTEMPTS} re-flatten attempts have already been spent on this ` +
        'lot and the residual is still open — falling back to the page and no longer trying',
    );
  }

  const closingSide = position.side === 'buy' ? 'sell' : 'buy';

  try {
    await store.writeAheadFlatten({
      idempotency_key: candidate,
      instrument: position.instrument,
      asset_class: position.asset_class,
      side: closingSide,
      size: residual,
      submitted_at: now,
      lot_held_quantities: [{ idempotency_key: lotKey, held: residual }],
      exit_reason: 'flatten',
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
  } catch (error) {
    if (error instanceof UnresolvedFlattenForInstrumentError) {
      return standDown(input, position, residual, lotKey, error.blocking_key);
    }
    return fail(
      input,
      position,
      residual,
      `writeAheadFlatten failed, so no market order was sent: ${describeThrownSafely(error)}`,
    );
  }

  let ack: Awaited<ReturnType<typeof broker.submitFlatten>>;
  try {
    ack = await broker.submitFlatten(position.instrument, closingSide, residual, candidate);
  } catch (error) {
    return fail(
      input,
      position,
      residual,
      `submitFlatten failed — the journal row stays 'submitting' for reconcile() to settle: ${describeThrownSafely(
        error,
      )}`,
    );
  }

  try {
    await store.resolveFlattenSubmitted(
      candidate,
      { order_state: ack.order_state, broker_order_ids: ack.broker_order_ids },
      now,
    );
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_reflatten_unresolved',
        level: 'warn',
        message:
          'resolveFlattenSubmitted failed after the residual re-flatten was accepted by the ' +
          "venue — the order is live and the journal row stays 'submitting' for reconcile()",
      },
      error,
      { idempotency_key: lotKey, flatten_key: candidate },
    );
  }

  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_submitted',
    level: 'warn',
    message:
      'this lot can never be re-armed, so the naked residual was CLOSED instead of ' +
      'protected (#1214) — a market order for the residual is live at the venue',
    payload: {
      idempotency_key: lotKey,
      flatten_key: candidate,
      instrument: position.instrument,
      side: closingSide,
      residual_qty: residual,
    },
  });

  return { kind: 'submitted', idempotency_key: candidate, qty: residual };
}

function isOwnReflattenKey(key: string, lotKey: string): boolean {
  return key.startsWith(`${lotKey}:residual-reflatten-`);
}

async function resolveReflattenKey(
  input: ResidualReflattenInput,
  lotKey: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RESIDUAL_REFLATTEN_ATTEMPTS; attempt++) {
    const candidate = `${lotKey}:residual-reflatten-${attempt}`;
    if (!(await input.store.findByKey(candidate))) return candidate;
  }
  return null;
}

function standDown(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  lotKey: string,
  blockingKey: string,
): ResidualReflattenOutcome {
  const own = isOwnReflattenKey(blockingKey, lotKey);
  return skip(
    input,
    position,
    residual,
    own ? 'own_reflatten_in_flight' : 'flatten_in_flight',
    own
      ? `this lot's own re-flatten '${blockingKey}' is still unresolved — the residual is already ` +
          'being closed, so this pass adds nothing and must not page'
      : `flatten '${blockingKey}' on this instrument is still unresolved — standing down rather ` +
          'than submitting a second market order against the same lot (#1214: the two paths must ' +
          'not both submit)',
  );
}

function skip(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  reason: ResidualReflattenSkipReason,
  detail: string,
): ResidualReflattenOutcome {
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_skipped',
    level: 'warn',
    message: `residual re-flatten stood down (${reason}) — the residual stays naked and the caller pages`,
    payload: {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      residual_qty: residual,
      reason,
      detail,
    },
  });
  return { kind: 'skipped', reason, detail };
}

function fail(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  detail: string,
): ResidualReflattenOutcome {
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_failed',
    level: 'error',
    message:
      'residual re-flatten failed — the residual is still open and unprotected, and the caller ' +
      'pages for it',
    payload: {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      residual_qty: residual,
      detail,
    },
  });
  return { kind: 'failed', detail };
}
