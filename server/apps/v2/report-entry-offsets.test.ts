import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { readJournalledEntries, reportEntryOffsets } from './report-entry-offsets.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'entry-offsets-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journal(path: string, rows: readonly [string, string, string, string, string, string][]) {
  const db = openSharedStore(path);
  const insert = db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'buy', 0, 'submitted', ?, '2026-09-28T00:00:00Z')`,
  );
  for (const [id, book, date, instrument, venue, leg] of rows) {
    insert.run(id, book, date, instrument, venue, leg, JSON.stringify({ price: 100, size: 1 }));
  }
  return db;
}

describe('readJournalledEntries', () => {
  it('reads one entry per date, instrument and side across books, Alpaca entries only', () => {
    const db = journal(join(scratch(), 'v2.sqlite'), [
      ['a', 'debate/primary', '2026-09-28', 'AAA', 'alpaca', 'entry'],
      ['b', 'debate/no-macro-gate', '2026-09-28', 'AAA', 'alpaca', 'entry'],
      ['c', 'debate/primary', '2026-09-28', 'BBB', 'saxo', 'entry'],
      ['d', 'debate/primary', '2026-09-29', 'AAA', 'alpaca', 'flatten'],
      ['e', 'debate/primary', '2026-09-29', 'CCC', 'alpaca', 'entry'],
    ]);
    db.prepare(`UPDATE v2_orders SET payload = '{}' WHERE client_order_id = 'e'`).run();
    db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES ('f', NULL, 'debate/primary', '2026-09-28', 'AAA', 'alpaca', 'entry', 'sell', 0,
         'submitted', '{"price":101}', '2026-09-28T00:00:00Z')`,
    ).run();
    expect(readJournalledEntries(db)).toEqual([
      { tradingDate: '2026-09-28', instrument: 'AAA', side: 'buy', limit: 100 },
      { tradingDate: '2026-09-28', instrument: 'AAA', side: 'sell', limit: 101 },
    ]);
    db.close();
  });
});

describe('reportEntryOffsets', () => {
  it('scores journalled entries against the bar store over the time-stop hold', async () => {
    const dir = scratch();
    const storePath = join(dir, 'v2.sqlite');
    journal(storePath, [['a', 'debate/primary', '2026-09-01', 'AAA', 'alpaca', 'entry']]).close();
    const dates = Array.from(
      { length: 12 },
      (_, day) => `2026-09-${String(day + 1).padStart(2, '0')}`,
    );
    const flat = (price: number) =>
      dates.map((date) => ({
        date,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        rawClose: price,
      }));
    const store = await ParquetBarStore.open(join(dir, 'bars'));
    await store.write('alpaca', [
      { symbol: 'AAA', bars: flat(100) },
      { symbol: 'SPY', bars: flat(400) },
    ]);
    store.close();
    const text = await reportEntryOffsets(storePath, join(dir, 'bars'));
    expect(text.split('\n')).toEqual([
      'entries scored: 1, awaiting 10 bars: 0',
      'offset      filled   mean excess per entry (bps, a miss counts 0)',
      '0 bps       100.0%   0.00',
      '50 bps      100.0%   0.00',
      '100 bps     100.0%   0.00',
      '200 bps     100.0%   0.00',
      'at the open 100.0%   0.00',
    ]);
  });

  it('refuses a store that does not exist', async () => {
    await expect(reportEntryOffsets(join(scratch(), 'missing.sqlite'), 'bars')).rejects.toThrow();
  });
});
