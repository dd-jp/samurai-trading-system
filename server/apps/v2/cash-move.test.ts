import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteCashAnchors } from './cash-anchor.js';
import { CASH_MOVE_USAGE, main, parseCashMoveArgs, recordCashMove } from './cash-move.js';
import { V2_STORE_PATH } from './index.js';

const clock = new SimulatedClock(new Date('2026-10-05T12:00:00.000Z'));
const FLAGS = [
  '--venue',
  'alpaca',
  '--amount',
  '1000',
  '--reference',
  'wire-1',
  '--date',
  '2026-10-05',
];

describe('parseCashMoveArgs', () => {
  it('parses a deposit or a withdrawal, the v2 store by default', () => {
    expect(parseCashMoveArgs(['deposit', ...FLAGS])).toEqual({
      move: {
        kind: 'deposit',
        venue: 'alpaca',
        amountQuote: 1_000,
        reference: 'wire-1',
        tradingDate: '2026-10-05',
      },
      storePath: V2_STORE_PATH,
    });
    expect(parseCashMoveArgs(['withdrawal', ...FLAGS, '--store', 'x.sqlite'])).toMatchObject({
      move: { kind: 'withdrawal' },
      storePath: 'x.sqlite',
    });
  });

  it('refuses an unknown move or venue, a missing flag and a dangling value', () => {
    expect(() => parseCashMoveArgs([])).toThrow(`unknown move \n${CASH_MOVE_USAGE}`);
    expect(() => parseCashMoveArgs(['adjust', ...FLAGS])).toThrow(/unknown move adjust/);
    expect(() => parseCashMoveArgs(['deposit', ...FLAGS.slice(2), '--venue', 'binance'])).toThrow(
      /unknown venue binance/,
    );
    expect(() => parseCashMoveArgs(['deposit', ...FLAGS.slice(0, 6)])).toThrow(
      /--date is required/,
    );
    expect(() =>
      parseCashMoveArgs(['deposit', ...FLAGS.slice(0, 6), '--date', '5/10/2026']),
    ).toThrow(/--date 5\/10\/2026 is not a YYYY-MM-DD date/);
    expect(() =>
      parseCashMoveArgs(['deposit', ...FLAGS.slice(0, 6), '--date', '2026-13-45']),
    ).toThrow(/--date 2026-13-45 is not a YYYY-MM-DD date/);
    expect(() =>
      parseCashMoveArgs(['deposit', ...FLAGS.slice(0, 6), '--date', '2026-02-30']),
    ).toThrow(/--date 2026-02-30 is not a YYYY-MM-DD date/);
    for (const amount of ['0x10', '1e3', ' 5', '5 ', '1.', '.5', '-5', '']) {
      expect(() =>
        parseCashMoveArgs(['deposit', '--amount', amount, ...FLAGS.slice(0, 2), ...FLAGS.slice(4)]),
      ).toThrow(`--amount ${amount} is not a decimal`);
    }
    expect(() => parseCashMoveArgs(['deposit', '--venue'])).toThrow(CASH_MOVE_USAGE);
    expect(() => parseCashMoveArgs(['deposit', 'venue', 'alpaca'])).toThrow(CASH_MOVE_USAGE);
  });
});

describe('recordCashMove', () => {
  it('journals the move against the anchor through the v2 write guard', () => {
    const db = openSharedStore(':memory:');
    new SqliteCashAnchors(db, clock).recordAnchor('alpaca', 'live', 12_000, '2026-10-01');
    expect(recordCashMove(parseCashMoveArgs(['deposit', ...FLAGS]).move, db, clock)).toEqual({
      currency: 'USD',
      cashQuote: 13_000,
      fillSeq: 0,
      brokerMode: 'live',
    });
    db.close();
  });
});

describe('main', () => {
  it('writes the move to the named store and returns the moved anchor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'v2-cash-move-'));
    const store = join(directory, 'v2.sqlite');
    const seeded = openSharedStore(store);
    new SqliteCashAnchors(seeded, clock).recordAnchor('alpaca', 'live', 12_000, '2026-10-01');
    seeded.close();
    try {
      expect(main(['withdrawal', ...FLAGS, '--store', store], clock)).toEqual({
        currency: 'USD',
        cashQuote: 11_000,
        fillSeq: 0,
        brokerMode: 'live',
      });
      expect(() => main(['withdrawal', ...FLAGS, '--store', store], clock)).toThrow(/append-only/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
