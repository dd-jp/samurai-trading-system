import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { type OrphanAlertChannel, OrphanVerdictScanner } from './orphan-verdict-scan.js';
import type { Logger } from './types.js';

const NOOP_LOGGER: Logger = { log: () => {} };

function insertVerdict(
  db: StoreHandle,
  args: { trace_id: string; idempotency_key: string; instrument: string; timestamp: string },
): void {
  db.prepare(
    `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
     VALUES (?, ?, ?, 'go', NULL, 0, ?)`,
  ).run(args.trace_id, args.idempotency_key, args.instrument, args.timestamp);
}

function insertAudit(db: StoreHandle, trace_id: string, stage: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO audit_log (trace_id, stage, decision, input_digest, output_digest, timestamp)
     VALUES (?, ?, 'proceed', 'in', 'out', ?)`,
  ).run(trace_id, stage, timestamp);
}

function seedOrphan(
  db: StoreHandle,
  trace_id: string,
  instrument: string,
  idempotency_key: string,
  timestamp = '2026-07-27T10:00:00.000Z',
): void {
  for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict']) {
    insertAudit(db, trace_id, stage, timestamp);
  }
  insertVerdict(db, { trace_id, idempotency_key, instrument, timestamp });
}

function seedHealthy(
  db: StoreHandle,
  trace_id: string,
  instrument: string,
  idempotency_key: string,
  timestamp = '2026-07-27T10:00:00.000Z',
): void {
  for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']) {
    insertAudit(db, trace_id, stage, timestamp);
  }
  insertVerdict(db, { trace_id, idempotency_key, instrument, timestamp });
}

function makeChannel(): OrphanAlertChannel & { postOrphanAlert: ReturnType<typeof vi.fn> } {
  return { postOrphanAlert: vi.fn().mockResolvedValue(undefined) };
}

describe('OrphanVerdictScanner', () => {
  it('a crash-restart between the go-verdict write and Execution surfaces an alert on a fresh handle over the same file (AC3)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDb = path.join(
      os.tmpdir(),
      `samurai-orphan-verdict-scan-test-${process.pid}-${Date.now()}.sqlite`,
    );
    const cleanup = () => {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(tmpDb + suffix)) fs.rmSync(tmpDb + suffix);
      }
    };
    cleanup();

    try {
      const db1 = openSharedStore(tmpDb);
      seedOrphan(db1, 'trace-crash-1', 'AAPL', 'idem-crash-1');
      db1.close();

      const db2 = openSharedStore(tmpDb);
      const channel = makeChannel();
      const scanner = new OrphanVerdictScanner();

      const orphans = await scanner.scan(db2, channel, NOOP_LOGGER);

      expect(orphans).toEqual([
        {
          trace_id: 'trace-crash-1',
          idempotency_key: 'idem-crash-1',
          instrument: 'AAPL',
          verdict_timestamp: new Date('2026-07-27T10:00:00.000Z'),
        },
      ]);
      expect(channel.postOrphanAlert).toHaveBeenCalledTimes(1);
      expect(channel.postOrphanAlert).toHaveBeenCalledWith(orphans[0]);
      db2.close();
    } finally {
      cleanup();
    }
  });

  it('alerts on an orphaned go-verdict and returns it, ignoring a healthy trace', async () => {
    const db = openSharedStore(':memory:');
    seedOrphan(db, 'trace-orphan-1', 'AAPL', 'idem-orphan-1');
    seedHealthy(db, 'trace-healthy-1', 'TSLA', 'idem-healthy-1');
    const channel = makeChannel();
    const scanner = new OrphanVerdictScanner();

    const orphans = await scanner.scan(db, channel, NOOP_LOGGER);

    expect(orphans).toEqual([
      {
        trace_id: 'trace-orphan-1',
        idempotency_key: 'idem-orphan-1',
        instrument: 'AAPL',
        verdict_timestamp: new Date('2026-07-27T10:00:00.000Z'),
      },
    ]);
    expect(channel.postOrphanAlert).toHaveBeenCalledTimes(1);
    expect(channel.postOrphanAlert).toHaveBeenCalledWith(orphans[0]);
  });

  it('returns nothing and never alerts when there are no go-verdicts at all', async () => {
    const db = openSharedStore(':memory:');
    const channel = makeChannel();
    const scanner = new OrphanVerdictScanner();

    const orphans = await scanner.scan(db, channel, NOOP_LOGGER);

    expect(orphans).toEqual([]);
    expect(channel.postOrphanAlert).not.toHaveBeenCalled();
  });

  it('does not flag a go-verdict whose no_go sibling trace lacks execution (status filter)', async () => {
    const db = openSharedStore(':memory:');
    insertAudit(db, 'trace-no-go', 'verdict', '2026-07-27T10:00:00.000Z');
    db.prepare(
      `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
       VALUES ('trace-no-go', 'idem-no-go', 'MSFT', 'no_go', 'risk breaker tripped', 0, '2026-07-27T10:00:00.000Z')`,
    ).run();
    const channel = makeChannel();
    const scanner = new OrphanVerdictScanner();

    const orphans = await scanner.scan(db, channel, NOOP_LOGGER);

    expect(orphans).toEqual([]);
    expect(channel.postOrphanAlert).not.toHaveBeenCalled();
  });

  it('keeps scanning and reporting past a channel failure on an earlier orphan', async () => {
    const db = openSharedStore(':memory:');
    seedOrphan(db, 'trace-orphan-a', 'AAPL', 'idem-a', '2026-07-27T09:00:00.000Z');
    seedOrphan(db, 'trace-orphan-b', 'BTC-USD', 'idem-b', '2026-07-27T10:00:00.000Z');
    const logger: Logger = { log: vi.fn() };
    const channel: OrphanAlertChannel = {
      postOrphanAlert: vi.fn().mockImplementation(async (orphan: { trace_id: string }) => {
        if (orphan.trace_id === 'trace-orphan-a') {
          throw new Error('channel unavailable');
        }
      }),
    };
    const scanner = new OrphanVerdictScanner();

    await expect(scanner.scan(db, channel, logger)).resolves.toEqual([
      expect.objectContaining({ trace_id: 'trace-orphan-a' }),
      expect.objectContaining({ trace_id: 'trace-orphan-b' }),
    ]);

    expect(channel.postOrphanAlert).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'trace-orphan-a',
        level: 'error',
        message: 'orphan go-verdict alert failed',
      }),
    );
  });
});
