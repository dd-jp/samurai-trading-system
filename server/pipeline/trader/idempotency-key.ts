import { createHash } from 'node:crypto';
import type { TradingArm } from '../../shared/index.js';

export type IntentSide = 'open' | 'close' | 'early_close';

export function intentSideFor(intentType: 'entry' | 'scale_in' | 'exit'): IntentSide {
  return intentType === 'exit' ? 'close' : 'open';
}

export function computeIdempotencyKey(
  instrument: string,
  bar: Date,
  side: IntentSide,
  arm: TradingArm = 'live',
): string {
  const payload =
    arm === 'live'
      ? JSON.stringify({ instrument, bar: bar.toISOString(), side })
      : JSON.stringify({ instrument, bar: bar.toISOString(), side, arm });

  return createHash('sha256').update(payload).digest('hex');
}

export function computeFlattenIdempotencyKey(
  instrument: string,
  sessionClose: Date,
  arm: TradingArm = 'live',
): string {
  const session_close = sessionClose.toISOString();
  const payload =
    arm === 'live'
      ? JSON.stringify({ instrument, session_close, side: 'close' })
      : JSON.stringify({ instrument, session_close, side: 'close', arm });

  return createHash('sha256').update(payload).digest('hex');
}
