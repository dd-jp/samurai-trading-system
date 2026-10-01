import type { Logger } from '../../shared/index.js';
import { logRefresh, messageOf } from './bar-refresh-core.js';
import { recordedSessionLoss, recordSessionLoss, sessionLossOf } from './execution/index.js';

export interface SaxoSessionLedger {
  readonly tokenPath: string | undefined;
  readonly now: () => Date;
  readonly logger: Logger;
}

export function ledgerFor(
  deps: { readonly tokenPath?: string | undefined; readonly now?: (() => Date) | undefined },
  logger: Logger,
): SaxoSessionLedger {
  return { tokenPath: deps.tokenPath, now: deps.now ?? (() => new Date()), logger };
}

export function noteSessionLoss(reason: string | undefined, ledger: SaxoSessionLedger): void {
  if (reason === undefined) return;
  try {
    recordSessionLoss(reason, ledger.now(), ledger.tokenPath);
  } catch (error) {
    logRefresh(
      ledger.logger,
      'warn',
      'v2_saxo_session_loss_unrecorded',
      `Saxo session loss (${reason}) not written to the keep-alive state: ${messageOf(error)}`,
    );
  }
}

// A recorded loss is not retried: a reconnect would only re-raise the critical alert the
// first detection already sent
export function connectUnlessLost<S>(connect: () => S, ledger: SaxoSessionLedger): S {
  const known = recordedSessionLoss(ledger.tokenPath);
  if (known !== undefined) throw new Error(known);
  try {
    return connect();
  } catch (error) {
    noteSessionLoss(sessionLossOf(error), ledger);
    throw error;
  }
}
