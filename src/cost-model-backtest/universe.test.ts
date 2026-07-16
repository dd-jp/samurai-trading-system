import { describe, expect, it } from 'vitest';
import {
  assertSurvivorshipFree,
  type DateRange,
  type InstrumentListing,
  type InstrumentRegistry,
  SurvivorshipViolationError,
} from './universe.js';

const WINDOW: DateRange = {
  start: new Date('2024-01-01T00:00:00.000Z'),
  end: new Date('2024-12-31T00:00:00.000Z'),
};

function registryOf(...membership: InstrumentListing[]): InstrumentRegistry {
  return { membershipDuring: async () => membership };
}

describe('assertSurvivorshipFree', () => {
  it('passes when every delisted member is retained in the universe', async () => {
    const registry = registryOf(
      { symbol: 'SPY' },
      { symbol: 'BUST', delisted_at: new Date('2024-06-01T00:00:00.000Z') },
    );

    await expect(
      assertSurvivorshipFree(['SPY', 'BUST'], WINDOW, registry),
    ).resolves.toBeUndefined();
  });

  it('rejects a universe that dropped a delisted member', async () => {
    const registry = registryOf(
      { symbol: 'SPY' },
      { symbol: 'BUST', delisted_at: new Date('2024-06-01T00:00:00.000Z') },
    );

    await expect(assertSurvivorshipFree(['SPY'], WINDOW, registry)).rejects.toThrow(
      SurvivorshipViolationError,
    );
  });

  it('names every dropped delisted member on the error', async () => {
    const registry = registryOf(
      { symbol: 'SPY' },
      { symbol: 'BUST', delisted_at: new Date('2024-06-01T00:00:00.000Z') },
      { symbol: 'GONE', delisted_at: new Date('2024-09-01T00:00:00.000Z') },
    );

    await expect(assertSurvivorshipFree(['SPY'], WINDOW, registry)).rejects.toMatchObject({
      missing: ['BUST', 'GONE'],
    });
  });

  it('does not require still-listed members to be present', async () => {
    const registry = registryOf({ symbol: 'SPY' }, { symbol: 'QQQ' });

    await expect(assertSurvivorshipFree(['SPY'], WINDOW, registry)).resolves.toBeUndefined();
  });

  it('allows a universe carrying names beyond the registry membership', async () => {
    const registry = registryOf({ symbol: 'SPY' });

    await expect(
      assertSurvivorshipFree(['SPY', 'BTC-USD'], WINDOW, registry),
    ).resolves.toBeUndefined();
  });

  it('passes an empty membership through', async () => {
    await expect(assertSurvivorshipFree([], WINDOW, registryOf())).resolves.toBeUndefined();
  });

  it('queries the registry for the replay window', async () => {
    const seen: DateRange[] = [];
    const registry: InstrumentRegistry = {
      membershipDuring: async (window) => {
        seen.push(window);
        return [];
      },
    };

    await assertSurvivorshipFree(['SPY'], WINDOW, registry);

    expect(seen).toEqual([WINDOW]);
  });
});
