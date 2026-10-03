import type BetterSqlite3 from 'better-sqlite3';
import { openSharedStore } from './open-shared-store.js';

interface Attack {
  readonly name: string;
  readonly sql: string;
  readonly outcome: 'refused' | 'ignored';
}

interface Case {
  readonly table: string;
  readonly seed: string;
  readonly attacks: readonly Attack[];
}

const SIGNAL_COLUMNS = `signal_id, payload_digest, symbol, entry_low, entry_high, entry_is_zone,
  targets, stop, received_at, session, process_after, payload`;

const CASH_ANCHOR_COLUMNS = `anchor_row_id, venue, kind, currency, amount_quote, fill_rowid,
  reference, trading_date, recorded_at`;

const CASES: readonly Case[] = [
  {
    table: 'v2_cash_anchors',
    seed: `INSERT INTO v2_cash_anchors (${CASH_ANCHOR_COLUMNS})
      VALUES (1, 'alpaca', 'anchor', 'USD', 12000, 7, 'go-live', '2026-10-01', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same anchor_row_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_cash_anchors (${CASH_ANCHOR_COLUMNS})
          VALUES (1, 'alpaca', 'deposit', 'USD', 500, NULL, 'wire-1', '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      },
      {
        name: 'a second anchor for the venue',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_rowid, reference, trading_date, recorded_at)
          VALUES ('alpaca', 'anchor', 'USD', 1, 9, 'go-live-again', '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      },
      {
        name: 'the same reference under a new id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_rowid, reference, trading_date, recorded_at)
          VALUES ('alpaca', 'deposit', 'USD', 5, NULL, 'go-live', '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_fill_reads',
    seed: `INSERT INTO v2_fill_reads (read_id, run_id, trading_date, client_order_id, filled_qty, error, recorded_at)
      VALUES (1, 'run-1', '2026-10-01', 'entry', 4, NULL, '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same read_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_fill_reads (read_id, run_id, trading_date, client_order_id, filled_qty, error, recorded_at)
          VALUES (1, 'run-1', '2026-10-01', 'entry', 0, NULL, '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_fill_sweeps',
    seed: `INSERT INTO v2_fill_sweeps (sweep_id, run_id, trading_date, first_fill_rowid, last_fill_rowid, order_rowid, book_day_rowid, recorded_at)
      VALUES (1, 'run-1', '2026-10-01', 0, 3, 0, 0, '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same sweep_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_fill_sweeps (sweep_id, run_id, trading_date, first_fill_rowid, last_fill_rowid, order_rowid, book_day_rowid, recorded_at)
          VALUES (1, 'run-1', '2026-10-01', 0, 9, 0, 0, '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_reconciles',
    seed: `INSERT INTO v2_reconciles (reconcile_id, trading_date, venue, source, status, book_ids, diffs, detail, recorded_at)
      VALUES (1, '2026-10-01', 'alpaca', 'broker', 'mismatch', '[]', '[]', 'original', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same reconcile_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_reconciles (reconcile_id, trading_date, venue, source, status, book_ids, diffs, detail, recorded_at)
          VALUES (1, '2026-10-01', 'alpaca', 'broker', 'clean', '[]', '[]', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_news',
    seed: `INSERT INTO v2_news (news_id, trading_date, symbol, provider, status, reason, requested, found, headlines, fetched_at)
      VALUES (1, '2026-10-01', 'AAPL', 'marketaux', 'ok', 'original', 1, 1, '[]', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same news_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_news (news_id, trading_date, symbol, provider, status, reason, requested, found, headlines, fetched_at)
          VALUES (1, '2026-10-01', 'AAPL', 'marketaux', 'no_news', 'rewritten', 1, 0, '[]', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_controls',
    seed: `INSERT INTO v2_controls (control_id, action, reason, source, idempotency_key, set_at)
      VALUES (1, 'halt', 'original', 'test', 'key-original', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same control_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_controls (control_id, action, reason, source, idempotency_key, set_at)
          VALUES (1, 'resume', 'rewritten', 'test', 'key-other', '2026-10-01T08:00:00.000Z')`,
      },
      {
        name: 'same idempotency_key under a new id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_controls (action, reason, source, idempotency_key, set_at)
          VALUES ('resume', 'rewritten', 'test', 'key-original', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_commands',
    seed: `INSERT INTO v2_commands (command_id, update_id, chat_id, command, outcome, detail, sent_at, handled_at)
      VALUES (1, 10, 'c', '/status', 'answered', 'original', '2026-10-01T07:00:00.000Z', '2026-10-01T07:00:01.000Z')`,
    attacks: [
      {
        name: 'same command_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_commands (command_id, update_id, chat_id, command, outcome, detail, sent_at, handled_at)
          VALUES (1, 11, 'c', '/status', 'noop', 'rewritten', '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:01.000Z')`,
      },
      {
        name: 'same update_id under a new id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_commands (update_id, chat_id, command, outcome, detail, sent_at, handled_at)
          VALUES (10, 'c', '/status', 'noop', 'rewritten', '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:01.000Z')`,
      },
    ],
  },
  {
    table: 'v2_signals',
    seed: `INSERT INTO v2_signals (${SIGNAL_COLUMNS})
      VALUES ('s1', 'digest-1', 'AAPL', 100, 101, 0, '[]', 95, '2026-10-01T07:00:00.000Z', 'in_session', '2026-10-01T07:00:00.000Z', 'original')`,
    attacks: [
      {
        name: 'same signal_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_signals (${SIGNAL_COLUMNS})
          VALUES ('s1', 'digest-2', 'AAPL', 100, 101, 0, '[]', 95, '2026-10-01T08:00:00.000Z', 'in_session', '2026-10-01T08:00:00.000Z', 'rewritten')`,
      },
      {
        name: 'same payload_digest under a new id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_signals (${SIGNAL_COLUMNS})
          VALUES ('s2', 'digest-1', 'AAPL', 100, 101, 0, '[]', 95, '2026-10-01T08:00:00.000Z', 'in_session', '2026-10-01T08:00:00.000Z', 'rewritten')`,
      },
    ],
  },
  {
    table: 'v2_signal_events',
    seed: `INSERT INTO v2_signals (${SIGNAL_COLUMNS})
        VALUES ('s1', 'digest-1', 'AAPL', 100, 101, 0, '[]', 95, '2026-10-01T07:00:00.000Z', 'in_session', '2026-10-01T07:00:00.000Z', 'p');
      INSERT INTO v2_signal_events (event_id, signal_id, status, detail, recorded_at)
        VALUES (1, 's1', 'queued', 'original', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same event_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_signal_events (event_id, signal_id, status, detail, recorded_at)
          VALUES (1, 's1', 'failed', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_trials',
    seed: `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
      VALUES (1, 'trend', 'hash-1', '{}', 'original', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same trial number',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
          VALUES (1, 'trend', 'hash-2', '{}', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
      {
        name: 'same config_hash under the next trial number',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
          VALUES (2, 'trend', 'hash-1', '{}', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_faults',
    seed: `INSERT INTO v2_faults (fault_id, kind, trading_date, code, detail, recorded_at)
      VALUES (1, 'stale_bar', '2026-10-01', 'CODE', 'original', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same fault_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_faults (fault_id, kind, trading_date, code, detail, recorded_at)
          VALUES (1, 'missed_stop', '2026-10-01', 'CODE', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
      {
        name: 'same fault tuple under a new id',
        outcome: 'ignored',
        sql: `INSERT OR REPLACE INTO v2_faults (kind, trading_date, code, detail, recorded_at)
          VALUES ('stale_bar', '2026-10-01', 'CODE', 'original', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_capital_config',
    seed: `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
      VALUES (2026, '2026-01-01', 10000, 1500, '2026-01-01T00:00:00.000Z')`,
    attacks: [
      {
        name: 'same year and effective_from',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
          VALUES (2026, '2026-01-01', 10000, 1000, '2026-06-01T00:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_heartbeat_pings',
    seed: `INSERT INTO v2_heartbeat_pings (ping_id, outcome, pinged_at) VALUES (1, 'success', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same ping_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_heartbeat_pings (ping_id, outcome, pinged_at)
          VALUES (1, 'fail', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_input_digests',
    seed: `INSERT INTO v2_input_digests (digest_id, trading_date, input, name, sha256, first_bar_date, last_bar_date, row_count, recorded_at)
      VALUES (1, '2026-10-01', 'bars', 'UP', 'aaa', '2026-01-01', '2026-09-30', 10, '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same digest_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_input_digests (digest_id, trading_date, input, name, sha256, first_bar_date, last_bar_date, row_count, recorded_at)
          VALUES (1, '2026-10-01', 'bars', 'UPX', 'bbb', '2026-01-01', '2026-09-30', 10, '2026-10-01T08:00:00.000Z')`,
      },
      {
        name: 'same trading_date, input and name under a new id',
        outcome: 'ignored',
        sql: `INSERT OR REPLACE INTO v2_input_digests (trading_date, input, name, sha256, first_bar_date, last_bar_date, row_count, recorded_at)
          VALUES ('2026-10-01', 'bars', 'UP', 'bbb', '2026-01-01', '2026-09-30', 10, '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_splits',
    seed: `INSERT INTO v2_splits (instrument, venue, split_date, ratio, trading_date, recorded_at)
      VALUES ('NVDA', 'alpaca', '2026-09-30', 4, '2026-10-01', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same instrument, venue and split date',
        outcome: 'ignored',
        sql: `INSERT OR REPLACE INTO v2_splits (instrument, venue, split_date, ratio, trading_date, recorded_at)
          VALUES ('NVDA', 'alpaca', '2026-09-30', 10, '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_cash_in_lieu',
    seed: `INSERT INTO v2_cash_in_lieu (venue, activity_id, instrument, activity_date, qty,
        amount_native, currency, fx_quote_per_gbp, fx_source, trading_date, recorded_at)
      VALUES ('alpaca', 'cil-1', 'NVDA', '2026-10-01', 0.5, 61.2, 'USD', 1.25,
        'boe-xudluss:year-start:2026@2025-12-31', '2026-10-01', '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same venue and activity id',
        outcome: 'ignored',
        sql: `INSERT OR REPLACE INTO v2_cash_in_lieu (venue, activity_id, instrument, activity_date,
            qty, amount_native, currency, fx_quote_per_gbp, fx_source, trading_date, recorded_at)
          VALUES ('alpaca', 'cil-1', 'NVDA', '2026-10-01', 0.5, 99, 'USD', 1.25,
            'boe-xudluss:year-start:2026@2025-12-31', '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_rescales',
    seed: `INSERT INTO v2_rescales (rescale_id, trading_date, book_id, instrument, source, ratio,
        anchor_date, fills_before, qty_before, qty_after, entry_before, entry_after, recorded_at)
      VALUES (1, '2026-10-01', 'debate/primary', 'NVDA', 'detector', 4, '2026-09-30', 0, 10, 40,
        400, 100, '2026-10-01T07:00:00.000Z')`,
    attacks: [
      {
        name: 'same rescale_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_rescales (rescale_id, trading_date, book_id, instrument,
            source, ratio, anchor_date, fills_before, qty_before, qty_after, entry_before,
            entry_after, recorded_at)
          VALUES (1, '2026-10-01', 'debate/primary', 'NVDA', 'detector', 1, '2026-09-30', 0, 10,
            10, 400, 400, '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
  {
    table: 'v2_flattens',
    seed: `INSERT INTO v2_controls (control_id, action, reason, source, idempotency_key, set_at)
        VALUES (1, 'halt', 'r', 'test', 'key-flatten', '2026-10-01T07:00:00.000Z');
      INSERT INTO v2_flattens (flatten_id, control_id, event, trading_date, outcome, detail, recorded_at)
        VALUES (1, 1, 'finished', '2026-10-01', 'failed', 'original', '2026-10-01T07:01:00.000Z')`,
    attacks: [
      {
        name: 'same flatten_id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_flattens (flatten_id, control_id, event, trading_date, outcome, detail, recorded_at)
          VALUES (1, 1, 'started', '2026-10-01', NULL, 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
      {
        name: 'same control and event under a new id',
        outcome: 'refused',
        sql: `INSERT OR REPLACE INTO v2_flattens (control_id, event, trading_date, outcome, detail, recorded_at)
          VALUES (1, 'finished', '2026-10-01', 'closed', 'rewritten', '2026-10-01T08:00:00.000Z')`,
      },
    ],
  },
];

function snapshot(db: BetterSqlite3.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
}

describe('INSERT OR REPLACE on the append-only v2 tables', () => {
  for (const { table, seed, attacks } of CASES) {
    for (const attack of attacks) {
      it(`${table}: ${attack.name} ${attack.outcome === 'refused' ? 'is refused' : 'is dropped'} and the row survives`, () => {
        const db = openSharedStore(':memory:');
        try {
          db.exec(seed);
          const before = snapshot(db, table);

          if (attack.outcome === 'refused') {
            expect(() => db.exec(attack.sql)).toThrow(/append-only|tightened|contiguous/);
          } else {
            expect(() => db.exec(attack.sql)).not.toThrow();
          }

          expect(snapshot(db, table)).toEqual(before);
        } finally {
          db.close();
        }
      });
    }
  }

  it('covers every v2 table that carries a no-update trigger', () => {
    const db = openSharedStore(':memory:');
    try {
      const guarded = (
        db
          .prepare(
            `SELECT DISTINCT tbl_name AS name FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'v2\\_%\\_no\\_update' ESCAPE '\\'`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      const covered = new Set<string>([...CASES.map((c) => c.table), 'v2_decisions', 'v2_fills']);
      expect(guarded.filter((name) => !covered.has(name))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('still takes the next row of each table with an auto-assigned id', () => {
    const db = openSharedStore(':memory:');
    try {
      db.exec(
        `INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail, recorded_at)
           VALUES ('2026-10-01', 'alpaca', 'broker', 'clean', '[]', '[]', 'a', 't');
         INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail, recorded_at)
           VALUES ('2026-10-01', 'alpaca', 'broker', 'clean', '[]', '[]', 'b', 't');
         INSERT INTO v2_faults (kind, trading_date, code, detail, recorded_at)
           VALUES ('stale_bar', '2026-10-01', 'C', 'a', 't');
         INSERT INTO v2_faults (kind, trading_date, code, detail, recorded_at)
           VALUES ('stale_bar', '2026-10-01', 'C', 'b', 't');`,
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM v2_reconciles').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM v2_faults').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});
