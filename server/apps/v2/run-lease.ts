import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

export type RunPurpose = 'cycle' | 'signals';

// A holder whose pid a later process reused would otherwise never be reclaimed; no cycle or
// signals pass runs anywhere near this long
export const RUN_LEASE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface RunLeaseHolder {
  readonly holder: string;
  readonly pid: number;
  readonly purpose: string;
  readonly acquired_at: string;
}

export type PidAlive = (pid: number) => boolean;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ReleaseLease = () => void;

export function describeHolder(holder: RunLeaseHolder | undefined): string {
  return `${holder?.purpose ?? 'nobody'} (pid ${holder?.pid ?? '-'})`;
}

export class RunLease {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly alive: PidAlive = pidAlive,
    private readonly pid: number = process.pid,
  ) {}

  current(): RunLeaseHolder | undefined {
    return this.db
      .prepare('SELECT holder, pid, purpose, acquired_at FROM v2_run_lease WHERE lease_id = 1')
      .get() as RunLeaseHolder | undefined;
  }

  tryAcquire(purpose: RunPurpose): ReleaseLease | undefined {
    const holder = randomUUID();
    const take = this.db.transaction(() => {
      const current = this.current();
      if (current !== undefined && this.#live(current)) return false;
      this.db.prepare('DELETE FROM v2_run_lease').run();
      this.db
        .prepare(
          `INSERT INTO v2_run_lease (lease_id, holder, pid, purpose, acquired_at)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(holder, this.pid, purpose, toStoredTimestamp(this.clock.now()));
      return true;
    });
    if (!take.immediate()) return undefined;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.db.prepare('DELETE FROM v2_run_lease WHERE holder = ?').run(holder);
    };
  }

  #live(current: RunLeaseHolder): boolean {
    const ageMs = this.clock.now().getTime() - Date.parse(current.acquired_at);
    return ageMs <= RUN_LEASE_MAX_AGE_MS && this.alive(current.pid);
  }
}

export interface LeaseWait {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
}

export async function withRunLease<T>(
  lease: Pick<RunLease, 'tryAcquire' | 'current'>,
  purpose: RunPurpose,
  wait: LeaseWait,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = wait.nowMs() + wait.timeoutMs;
  let release = lease.tryAcquire(purpose);
  while (release === undefined) {
    if (wait.nowMs() >= deadline) {
      const holder = lease.current();
      throw new Error(
        `v2 run lease not acquired for ${purpose} within ${wait.timeoutMs} ms: held by ${describeHolder(holder)} since ${holder?.acquired_at ?? '-'}`,
      );
    }
    await wait.sleep(wait.pollMs);
    release = lease.tryAcquire(purpose);
  }
  try {
    return await run();
  } finally {
    release();
  }
}
