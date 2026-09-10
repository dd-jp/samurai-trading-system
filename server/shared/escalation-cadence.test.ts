import { escalatesAt } from './escalation-cadence.js';

describe('escalatesAt', () => {
  it('fires at `after`, then every `every`, never before', () => {
    const cadence = { after: 2, every: 8 };
    const firing = Array.from({ length: 30 }, (_, i) => i + 1).filter((n) =>
      escalatesAt(n, cadence),
    );
    expect(firing).toEqual([2, 10, 18, 26]);
  });

  it('with after 1 is the first-then-every-Mth rule the drifted sites wrote inline', () => {
    const cadence = { after: 1, every: 8 };
    for (let n = 1; n <= 40; n += 1) {
      expect(escalatesAt(n, cadence)).toBe((n - 1) % 8 === 0);
    }
  });

  it('never fires at zero', () => {
    expect(escalatesAt(0, { after: 1, every: 1 })).toBe(false);
  });
});
