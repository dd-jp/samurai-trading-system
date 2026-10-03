import { DEFAULT_VENUE_PACING } from './venue-pacing.js';

const DOCUMENTED_CEILING_PER_SECOND = {
  alpaca: 200 / 60,
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
    '%s leaves a token for background callers after the priority reserve',
    (_venue, pacing) => {
      expect(pacing.reserveForPriority ?? 0).toBeLessThanOrEqual(pacing.capacity - 1);
    },
  );
});
