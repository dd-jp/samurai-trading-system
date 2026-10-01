import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import {
  type LeaseWait,
  pidAlive,
  RUN_LEASE_MAX_AGE_MS,
  RunLease,
  withRunLease,
} from './run-lease.js';

let now = new Date('2026-09-30T06:30:00.000Z');
const clock = { now: () => now };
const handles: StoreHandle[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  now = new Date('2026-09-30T06:30:00.000Z');
});

function sharedPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-lease-'));
  dirs.push(dir);
  return join(dir, 'v2.sqlite');
}

function open(path: string): StoreHandle {
  const handle = openSharedStore(path);
  handles.push(handle);
  return handle;
}

const everyoneAlive = () => true;
const everyoneDead = () => false;

describe('RunLease', () => {
  it('admits one holder across two connections until it releases', () => {
    const path = sharedPath();
    const cycle = new RunLease(open(path), clock, everyoneAlive, 101);
    const signals = new RunLease(open(path), clock, everyoneAlive, 202);
    const release = cycle.tryAcquire('cycle');
    expect(release).toBeTypeOf('function');
    expect(signals.tryAcquire('signals')).toBeUndefined();
    expect(signals.current()).toMatchObject({ pid: 101, purpose: 'cycle' });
    release?.();
    const second = signals.tryAcquire('signals');
    expect(second).toBeTypeOf('function');
    expect(cycle.current()).toMatchObject({ pid: 202, purpose: 'signals' });
  });

  it('refuses a second acquire from the same live process', () => {
    const lease = new RunLease(open(':memory:'), clock, everyoneAlive, 7);
    expect(lease.tryAcquire('cycle')).toBeTypeOf('function');
    expect(lease.tryAcquire('signals')).toBeUndefined();
  });

  it('reclaims a lease whose holder pid is dead', () => {
    const path = sharedPath();
    new RunLease(open(path), clock, everyoneAlive, 101).tryAcquire('cycle');
    const reclaimer = new RunLease(open(path), clock, (pid) => pid !== 101, 202);
    expect(reclaimer.tryAcquire('signals')).toBeTypeOf('function');
    expect(reclaimer.current()).toMatchObject({ pid: 202, purpose: 'signals' });
  });

  it('reclaims a live-looking lease only once it is older than the max age', () => {
    const path = sharedPath();
    new RunLease(open(path), clock, everyoneAlive, 101).tryAcquire('cycle');
    const other = new RunLease(open(path), clock, everyoneAlive, 202);
    now = new Date(Date.parse('2026-09-30T06:30:00.000Z') + RUN_LEASE_MAX_AGE_MS);
    expect(other.tryAcquire('signals')).toBeUndefined();
    now = new Date(now.getTime() + 1);
    expect(other.tryAcquire('signals')).toBeTypeOf('function');
  });

  it('a stale release never frees a lease someone else now holds', () => {
    const path = sharedPath();
    const first = new RunLease(open(path), clock, everyoneAlive, 101);
    const staleRelease = first.tryAcquire('cycle');
    const second = new RunLease(open(path), clock, everyoneDead, 202);
    expect(second.tryAcquire('signals')).toBeTypeOf('function');
    staleRelease?.();
    staleRelease?.();
    expect(second.current()).toMatchObject({ pid: 202 });
  });

  it('the lease table holds at most one row', () => {
    const db = open(':memory:');
    new RunLease(db, clock, everyoneAlive, 1).tryAcquire('cycle');
    expect(() =>
      db
        .prepare(
          "INSERT INTO v2_run_lease (lease_id, holder, pid, purpose, acquired_at) VALUES (2, 'x', 1, 'cycle', 't')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('pidAlive', () => {
  it('sees this process as alive and an unused pid as dead', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_147_483_646)).toBe(false);
  });

  it('sees a pid it may not signal (EPERM) as alive', () => {
    expect(pidAlive(1)).toBe(true);
  });
});

describe('RUN_LEASE_MAX_AGE_MS', () => {
  it('is six hours', () => {
    expect(RUN_LEASE_MAX_AGE_MS).toBe(21_600_000);
  });
});

function fakeWait(timeoutMs: number): LeaseWait & { slept: number[] } {
  let elapsed = 0;
  const slept: number[] = [];
  return {
    timeoutMs,
    pollMs: 1_000,
    slept,
    nowMs: () => elapsed,
    sleep: (ms) => {
      slept.push(ms);
      elapsed += ms;
      return Promise.resolve();
    },
  };
}

describe('withRunLease', () => {
  it('runs under the lease and releases it', async () => {
    const lease = new RunLease(open(':memory:'), clock, everyoneAlive, 1);
    const result = await withRunLease(lease, 'cycle', fakeWait(0), () => {
      expect(lease.current()).toMatchObject({ purpose: 'cycle' });
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(lease.current()).toBeUndefined();
  });

  it('releases the lease when the run throws', async () => {
    const lease = new RunLease(open(':memory:'), clock, everyoneAlive, 1);
    await expect(
      withRunLease(lease, 'signals', fakeWait(0), () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(lease.current()).toBeUndefined();
  });

  it('waits for the holder, polling, then runs', async () => {
    const path = sharedPath();
    const holder = new RunLease(open(path), clock, everyoneAlive, 101);
    const release = holder.tryAcquire('signals');
    const waiter = new RunLease(open(path), clock, everyoneAlive, 202);
    const wait = fakeWait(10_000);
    const originalSleep = wait.sleep;
    const polling: LeaseWait = {
      ...wait,
      sleep: async (ms) => {
        await originalSleep(ms);
        if (wait.slept.length === 3) release?.();
      },
    };
    await withRunLease(waiter, 'cycle', polling, () => Promise.resolve());
    expect(wait.slept).toEqual([1_000, 1_000, 1_000]);
  });

  it('gives up after the timeout and names the holder', async () => {
    const path = sharedPath();
    new RunLease(open(path), clock, everyoneAlive, 101).tryAcquire('signals');
    const waiter = new RunLease(open(path), clock, everyoneAlive, 202);
    let ran = false;
    await expect(
      withRunLease(waiter, 'cycle', fakeWait(2_500), () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(
      'v2 run lease not acquired for cycle within 2500 ms: held by signals (pid 101) since 2026-09-30T06:30:00.000Z',
    );
    expect(ran).toBe(false);
  });

  it('names nobody when the holder left between the last try and the message', async () => {
    const lease = {
      tryAcquire: () => undefined,
      current: () => undefined,
    };
    await expect(
      withRunLease(lease, 'cycle', fakeWait(0), () => Promise.resolve()),
    ).rejects.toThrow('held by nobody (pid -) since -');
  });
});
