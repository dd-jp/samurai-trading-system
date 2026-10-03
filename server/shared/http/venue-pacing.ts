import type { TokenBucketConfig } from './token-bucket.js';

export const DEFAULT_VENUE_PACING: Readonly<Record<'alpaca' | 'saxo', TokenBucketConfig>> = {
  alpaca: { capacity: 41, refillPerSecond: 2.0, reserveForPriority: 21 },
  saxo: { capacity: 2, refillPerSecond: 1, reserveForPriority: 1 },
};
