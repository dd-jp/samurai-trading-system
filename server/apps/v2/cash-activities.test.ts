import { describe, expect, it, vi } from 'vitest';
import type {
  BrokerCashActivity,
  BrokerCashActivityReader,
  BrokerMode,
} from '../../../contracts/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { CASH_ACTIVITY_LOOKBACK_DAYS, readBrokerCashActivities } from './cash-activities.js';
import { SqliteCashAnchors } from './cash-anchor.js';

const ANCHOR_DATE = '2026-10-01';
const TODAY = '2026-10-07';

const DIV: BrokerCashActivity = {
  activity_id: 'div-1',
  activity_type: 'DIV',
  activity_date: '2026-10-05',
  amount: 4.2,
  status: 'executed',
};

function harness(
  options: {
    read?: BrokerCashActivityReader['read'];
    anchorMode?: BrokerMode | undefined;
    anchorDate?: string;
    runMode?: BrokerMode;
  } = {},
) {
  const db = migratedMemoryStore();
  const anchors = new SqliteCashAnchors(
    db,
    new SimulatedClock(new Date('2026-10-07T07:00:00.000Z')),
  );
  const mode = 'anchorMode' in options ? options.anchorMode : 'live';
  if (mode !== undefined) {
    anchors.recordAnchor('alpaca', mode, 1_000, options.anchorDate ?? ANCHOR_DATE);
  }
  const entries: LogEntry[] = [];
  const reader = { venue: 'alpaca' as const, read: vi.fn(options.read ?? (async () => [DIV])) };
  const deps = {
    cashActivities: reader,
    cashAnchors: anchors,
    brokerMode: options.runMode ?? 'live',
    logger: { log: (entry: LogEntry) => entries.push(entry) },
  };
  return { deps, reader, anchors, entries };
}

describe('readBrokerCashActivities (David 2026-10-03, #2035 item 5)', () => {
  it("journals each activity from the anchor's day on as a move, once", async () => {
    const { deps, reader, anchors, entries } = harness({
      read: async () => [DIV, { ...DIV, activity_id: 'fee-1', activity_type: 'FEE', amount: -0.5 }],
    });
    await expect(readBrokerCashActivities(deps, TODAY)).resolves.toBe(2);
    expect(reader.read).toHaveBeenCalledWith('2026-09-30');
    expect(anchors.anchor('alpaca')?.cashQuote).toBe(1_003.7);
    expect(entries.map((entry) => [entry.level, entry.event])).toEqual([
      ['info', 'v2_cash_activity_read'],
      ['info', 'v2_cash_activity_read'],
    ]);
    expect(entries[0]?.message).toBe(
      'alpaca reported DIV 4.2 on 2026-10-05 (activity div-1, executed); journalled as a cash anchor move',
    );
    await expect(readBrokerCashActivities(deps, TODAY)).resolves.toBe(0);
    expect(anchors.anchor('alpaca')?.cashQuote).toBe(1_003.7);
  });

  it("counts an activity dated on the anchor's day, which the 02:30 ET anchor read came before, and none dated earlier", async () => {
    const { deps, anchors } = harness({
      read: async () => [
        { ...DIV, activity_id: 'day-before', activity_date: '2026-09-30', amount: 9 },
        { ...DIV, activity_id: 'anchor-day', activity_date: ANCHOR_DATE, amount: 2 },
      ],
    });
    await expect(readBrokerCashActivities(deps, TODAY)).resolves.toBe(1);
    expect(anchors.anchor('alpaca')?.cashQuote).toBe(1_002);
  });

  it('reads no further back than the lookback once the anchor is older', async () => {
    const { deps, reader } = harness({ anchorDate: '2026-01-02' });
    await readBrokerCashActivities(deps, TODAY);
    expect(CASH_ACTIVITY_LOOKBACK_DAYS).toBe(90);
    expect(reader.read).toHaveBeenCalledWith('2026-07-09');
  });

  it('reads nothing without a reader, a ledger, an anchor, or an anchor of this account', async () => {
    const none = harness({ anchorMode: undefined });
    await expect(readBrokerCashActivities(none.deps, TODAY)).resolves.toBe(0);
    expect(none.reader.read).not.toHaveBeenCalled();
    const otherAccount = harness({ anchorMode: 'live', runMode: 'paper' });
    await expect(readBrokerCashActivities(otherAccount.deps, TODAY)).resolves.toBe(0);
    expect(otherAccount.reader.read).not.toHaveBeenCalled();
    const { deps, reader } = harness();
    await expect(
      readBrokerCashActivities({ ...deps, cashActivities: undefined }, TODAY),
    ).resolves.toBe(0);
    await expect(
      readBrokerCashActivities({ ...deps, cashAnchors: undefined }, TODAY),
    ).resolves.toBe(0);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('warns and journals nothing when the read fails, never failing the cycle', async () => {
    const { deps, anchors, entries } = harness({
      read: async () => {
        throw new Error('503 from activities');
      },
    });
    await expect(readBrokerCashActivities(deps, TODAY)).resolves.toBe(0);
    expect(anchors.anchor('alpaca')?.cashQuote).toBe(1_000);
    expect(entries).toEqual([
      {
        trace_id: 'v2-2026-10-07',
        stage: 'v2',
        level: 'warn',
        event: 'v2_cash_activity_read_failed',
        message:
          'alpaca non-trade cash read failed; the cash check runs on the moves already journalled: 503 from activities',
      },
    ]);
    const throwingLogger = {
      ...deps,
      logger: {
        log: () => {
          throw new Error('log sink down');
        },
      },
    };
    await expect(readBrokerCashActivities(throwingLogger, TODAY)).resolves.toBe(0);
  });

  it('survives a ledger that throws', async () => {
    const { deps, entries } = harness();
    const broken = {
      ...deps,
      cashAnchors: {
        anchor: () => {
          throw new Error('store locked');
        },
        recordActivity: () => true,
      },
    };
    await expect(readBrokerCashActivities(broken, TODAY)).resolves.toBe(0);
    expect(entries.map((entry) => entry.event)).toEqual(['v2_cash_activity_read_failed']);
  });
});
