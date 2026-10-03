import { DEFAULT_VENUE_PACING } from './venue-pacing.js';

const DOCUMENTED_CEILING_PER_SECOND = {
  // docs/research/32-vendor-api-reference.md: 200 requests/minute per API key
  alpaca: 200 / 60,
  // docs/research/43-saxo-openapi-order-idempotency.md: 120 requests/minute per service group
  saxo: 120 / 60,
} as const;

describe('DEFAULT_VENUE_PACING', () => {
  it.each(Object.entries(DEFAULT_VENUE_PACING))(
    '%s sustains a rate at or under its documented ceiling',
    (venue, pacing) => {
      const ceiling =
        DOCUMENTED_CEILING_PER_SECOND[venue as keyof typeof DOCUMENTED_CEILING_PER_SECOND];
      expect(pacing.refillPerSecond).toBeLessThanOrEqual(ceiling);
    },
  );

  it.each(Object.entries(DEFAULT_VENUE_PACING))(
    '%s keeps a full burst plus a minute of refill inside the per-minute ceiling',
    (venue, pacing) => {
      const ceiling =
        DOCUMENTED_CEILING_PER_SECOND[venue as keyof typeof DOCUMENTED_CEILING_PER_SECOND];
      expect(pacing.capacity + pacing.refillPerSecond * 60).toBeLessThanOrEqual(ceiling * 60);
    },
  );

  it.each(Object.entries(DEFAULT_VENUE_PACING))(
    '%s leaves a token for background callers after the priority reserve',
    (_venue, pacing) => {
      expect(pacing.reserveForPriority ?? 0).toBeLessThanOrEqual(pacing.capacity - 1);
    },
  );
});
