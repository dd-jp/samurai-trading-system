import { guardedStore, openSharedStore } from '../../../shared/store/index.js';
import { type NewsRecord, SqliteNewsLedger } from './news-ledger.js';

function row(overrides: Partial<NewsRecord> = {}): NewsRecord {
  return {
    tradingDate: '2026-09-29',
    symbol: 'AZN',
    provider: 'marketaux',
    status: 'ok',
    reason: 'found=1',
    requested: true,
    found: 1,
    headlines: [{ title: 'h', publishedAt: '2026-09-28T09:00:00.000Z' }],
    fetchedAt: '2026-09-29T07:00:00.000Z',
    ...overrides,
  };
}

function ledgerOver() {
  const db = openSharedStore(':memory:');
  return { db, ledger: new SqliteNewsLedger(guardedStore(db, 'v2', { enabled: true })) };
}

describe('SqliteNewsLedger', () => {
  it('round-trips a record including headlines and an absent found count', () => {
    const { ledger } = ledgerOver();
    ledger.record(row());
    ledger.record(
      row({ symbol: 'BP', status: 'error', reason: 'http_500', found: undefined, headlines: [] }),
    );
    expect(ledger.forDate('2026-09-29')).toEqual([
      row(),
      row({ symbol: 'BP', status: 'error', reason: 'http_500', found: undefined, headlines: [] }),
    ]);
  });

  it('caches only ok and no_news, newest first, per date and symbol', () => {
    const { ledger } = ledgerOver();
    expect(ledger.cached('marketaux', '2026-09-29', 'AZN')).toBeUndefined();
    ledger.record(row({ status: 'error', reason: 'http_500', headlines: [] }));
    ledger.record(row({ status: 'budget_stop', reason: 'budget_stop', headlines: [] }));
    ledger.record(row({ status: 'no_key', reason: 'no_api_key', headlines: [] }));
    expect(ledger.cached('marketaux', '2026-09-29', 'AZN')).toBeUndefined();
    ledger.record(row({ status: 'no_news', reason: 'empty', found: 0, headlines: [] }));
    ledger.record(row({ reason: 'found=2' }));
    expect(ledger.cached('marketaux', '2026-09-29', 'AZN')?.reason).toBe('found=2');
    ledger.record(
      row({
        symbol: 'SHEL',
        status: 'no_news',
        reason: 'window_not_open',
        requested: false,
        headlines: [],
      }),
    );
    expect(ledger.cached('marketaux', '2026-09-29', 'SHEL')).toBeUndefined();
    expect(ledger.cached('marketaux', '2026-09-28', 'AZN')).toBeUndefined();
    expect(ledger.cached('marketaux', '2026-09-29', 'BP')).toBeUndefined();
  });

  it('keys the cache, the first lookup and an optional date filter by provider', () => {
    const { ledger } = ledgerOver();
    const us = row({
      provider: 'alpaca',
      reason: '',
      headlines: [{ title: 'u', publishedAt: '2026-09-28T09:00:00.000Z', sourceId: '42' }],
    });
    ledger.record(us);
    expect(ledger.cached('marketaux', '2026-09-29', 'AZN')).toBeUndefined();
    expect(ledger.cached('alpaca', '2026-09-29', 'AZN')).toEqual(us);
    ledger.record(row());
    ledger.record(row({ provider: 'alpaca', status: 'error', reason: 'rerun', headlines: [] }));
    expect(ledger.first('alpaca', '2026-09-29', 'AZN')).toEqual(us);
    expect(ledger.first('marketaux', '2026-09-29', 'AZN')).toEqual(row());
    expect(ledger.first('alpaca', '2026-09-28', 'AZN')).toBeUndefined();
    expect(ledger.forDate('2026-09-29', 'marketaux')).toEqual([row()]);
    expect(ledger.forDate('2026-09-29')).toHaveLength(3);
  });

  it('counts only requests made by that provider since the given instant', () => {
    const { ledger } = ledgerOver();
    ledger.record(row({ fetchedAt: '2026-09-28T23:59:59.999Z' }));
    ledger.record(row({ fetchedAt: '2026-09-29T00:00:00.000Z' }));
    ledger.record(row({ fetchedAt: '2026-09-29T07:00:00.000Z', requested: false }));
    ledger.record(row({ fetchedAt: '2026-09-29T07:00:00.000Z', provider: 'eodhd' }));
    const usage = ledger.usageSince('marketaux', '2026-09-29T00:00:00.000Z');
    expect(usage).toEqual({ requests: 1, quotaRefused: false });
  });

  it('flags a usage-limit refusal (402) today', () => {
    const reason = 'http_402';
    const { ledger } = ledgerOver();
    ledger.record(row({ status: 'error', reason, headlines: [] }));
    expect(ledger.usageSince('marketaux', '2026-09-29T00:00:00.000Z').quotaRefused).toBe(true);
    expect(ledger.usageSince('marketaux', '2026-09-30T00:00:00.000Z').quotaRefused).toBe(false);
  });

  it('does not flag a rate limit or a server error as a quota refusal', () => {
    const { ledger } = ledgerOver();
    ledger.record(row({ status: 'error', reason: 'http_500', headlines: [] }));
    ledger.record(row({ status: 'error', reason: 'http_429', headlines: [] }));
    expect(ledger.usageSince('marketaux', '2026-09-29T00:00:00.000Z')).toEqual({
      requests: 2,
      quotaRefused: false,
    });
  });

  it('is append-only', () => {
    const { db, ledger } = ledgerOver();
    ledger.record(row());
    expect(() => db.prepare("UPDATE v2_news SET status = 'error'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM v2_news').run()).toThrow(/append-only/);
  });

  it('rejects a status outside the journal vocabulary', () => {
    const { ledger } = ledgerOver();
    expect(() => ledger.record(row({ status: 'weird' as NewsRecord['status'] }))).toThrow();
  });

  it('is written through the v2 stage handle and refused for another stage', () => {
    const db = openSharedStore(':memory:');
    const other = new SqliteNewsLedger(guardedStore(db, 'telegram', { enabled: true }));
    expect(() => other.record(row())).toThrow(/Sole-writer violation/);
  });
});
