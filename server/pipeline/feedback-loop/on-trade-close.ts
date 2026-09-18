import type { ClosedTrade } from '../../shared/index.js';
import { realizedR } from './attribution.js';
import type { OnTradeCloseInput } from './types.js';

export function onTradeClose(
  trade: ClosedTrade,
  _trace_id: string,
  input: OnTradeCloseInput,
): void {
  const r = realizedR(trade);
  if (r === null) {
    return;
  }

  input.setup_store.labelSetup(trade.debate_id, r, trade.closed_at);
}
