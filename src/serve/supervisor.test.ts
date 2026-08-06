import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { type SpawnFn, startSupervisor } from './supervisor.js';

/**
 * Stands in for a spawned process: records the signals sent to it, and lets a
 * test decide exactly when — and how — it dies.
 */
class FakeChild extends EventEmitter {
  readonly signals: (NodeJS.Signals | undefined)[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal as NodeJS.Signals | undefined);
    return true;
  }

  /** Simulates the OS reaping the process. */
  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function fakeSpawn(): {
  spawn: SpawnFn;
  calls: { command: string; args: readonly string[] }[];
  children: FakeChild[];
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  const children: FakeChild[] = [];

  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };

  return { spawn, calls, children };
}

/** Both children, in spawn order: orchestrator first, then dashboard. */
function start(log: (message: string) => void = () => {}) {
  const { spawn, calls, children } = fakeSpawn();
  const supervisor = startSupervisor({
    spawn,
    execPath: '/usr/bin/node',
    log,
    // The real one opens SQLite; the ordering it guarantees is tested below.
    prepare: () => {},
  });
  const [orchestrator, dashboard] = children;
  if (orchestrator === undefined || dashboard === undefined) {
    throw new Error(`expected two children, spawned ${children.length}`);
  }
  return { supervisor, calls, orchestrator, dashboard };
}

describe('startSupervisor', () => {
  it('spawns both built entrypoints with the env file the standalone scripts use', () => {
    const { calls } = start();

    expect(calls).toEqual([
      {
        command: '/usr/bin/node',
        args: ['--env-file=.env.local', 'dist/orchestrator/index.js'],
      },
      {
        command: '/usr/bin/node',
        args: ['--env-file=.env.local', 'dist/dashboard/index.js'],
      },
    ]);
  });

  it('forwards a shutdown signal to both children', () => {
    const { supervisor, orchestrator, dashboard } = start();

    supervisor.shutdown('SIGINT');

    expect(orchestrator.signals).toEqual(['SIGINT']);
    expect(dashboard.signals).toEqual(['SIGINT']);
  });

  it('does not resolve until BOTH children have exited', async () => {
    const { supervisor, orchestrator, dashboard } = start();
    let resolved = false;
    void supervisor.done.then(() => {
      resolved = true;
    });

    supervisor.shutdown('SIGTERM');
    dashboard.die(0);
    await Promise.resolve();

    // The orchestrator is still draining its in-flight tick. Exiting now would
    // orphan it mid-pass — the whole reason the supervisor waits.
    expect(resolved).toBe(false);

    orchestrator.die(0);
    await expect(supervisor.done).resolves.toBe(0);
  });

  it('is idempotent under a second signal', () => {
    const { supervisor, orchestrator, dashboard } = start();

    supervisor.shutdown('SIGINT');
    supervisor.shutdown('SIGINT');

    expect(orchestrator.signals).toEqual(['SIGINT']);
    expect(dashboard.signals).toEqual(['SIGINT']);
  });

  it('stops the orchestrator when the dashboard dies unrequested, and fails', async () => {
    const messages: string[] = [];
    const { supervisor, orchestrator, dashboard } = start((m) => messages.push(m));

    dashboard.die(1);
    expect(orchestrator.signals).toEqual(['SIGTERM']);

    orchestrator.die(0);
    await expect(supervisor.done).resolves.toBe(1);
    expect(messages).toEqual(['dashboard exited (code 1); stopping the other.']);
  });

  it('stops the dashboard when the orchestrator dies unrequested, and fails', async () => {
    const { supervisor, orchestrator, dashboard } = start();

    orchestrator.die(2);
    expect(dashboard.signals).toEqual(['SIGTERM']);

    dashboard.die(0);
    await expect(supervisor.done).resolves.toBe(2);
  });

  it('fails when a child exits 0 on its own, matching what it logged', async () => {
    const messages: string[] = [];
    const { supervisor, orchestrator, dashboard } = start((m) => messages.push(m));

    // `kill -TERM` aimed at the orchestrator alone: it drains and returns 0.
    // Nobody asked `serve` to stop, so this is still a failure — logging
    // "stopping the other" and then exiting 0 would contradict itself.
    orchestrator.die(0);

    expect(dashboard.signals).toEqual(['SIGTERM']);
    dashboard.die(0);
    await expect(supervisor.done).resolves.toBe(1);
    expect(messages).toEqual(['orchestrator exited (code 0); stopping the other.']);
  });

  it('reports a failure exit code even when the first child died cleanly', async () => {
    const { supervisor, orchestrator, dashboard } = start();

    // A crash with no exit code (killed, not returned) still has to be a
    // failure rather than the `?? 0` it would otherwise fall through to.
    orchestrator.die(null, 'SIGSEGV');
    dashboard.die(0);

    await expect(supervisor.done).resolves.toBe(1);
  });

  it('treats a group-delivered Ctrl-C as a requested stop, not a crash', async () => {
    const messages: string[] = [];
    const { supervisor, orchestrator, dashboard } = start((m) => messages.push(m));

    // The terminal signals the whole process group, so a child can be reaped
    // before the supervisor's own handler runs. That must not read as a crash.
    dashboard.die(null, 'SIGINT');
    orchestrator.die(0);

    await expect(supervisor.done).resolves.toBe(0);
    expect(messages).toEqual([]);
  });

  it('surfaces a non-zero exit from a requested shutdown', async () => {
    const { supervisor, orchestrator, dashboard } = start();

    supervisor.shutdown('SIGTERM');
    // buildShutdownHandler exits 1 when the drain itself rejects.
    orchestrator.die(1);
    dashboard.die(0);

    await expect(supervisor.done).resolves.toBe(1);
  });

  describe('store migration', () => {
    it('runs to completion before either child is spawned', () => {
      const order: string[] = [];
      const { spawn, children } = fakeSpawn();

      startSupervisor({
        spawn: (command, args) => {
          order.push('spawn');
          return spawn(command, args);
        },
        prepare: () => order.push('prepare'),
      });

      // The point of the ordering: both children open an already-migrated
      // database, so neither races the other through `CREATE TABLE`.
      expect(order).toEqual(['prepare', 'spawn', 'spawn']);
      expect(children).toHaveLength(2);
    });

    it('spawns nothing when the migration fails', () => {
      const { spawn, children } = fakeSpawn();

      expect(() =>
        startSupervisor({
          spawn,
          prepare: () => {
            throw new Error('database is locked');
          },
        }),
      ).toThrow('database is locked');
      expect(children).toEqual([]);
    });
  });

  describe("a child's 'error' event", () => {
    it('stops the other child and fails rather than throwing', async () => {
      const messages: string[] = [];
      const { supervisor, orchestrator, dashboard } = start((m) => messages.push(m));

      orchestrator.emit('error', new Error('spawn ENOENT'));

      expect(dashboard.signals).toEqual(['SIGTERM']);
      dashboard.die(0);
      await expect(supervisor.done).resolves.toBe(1);
      expect(messages).toEqual(['orchestrator failed: spawn ENOENT; stopping the other.']);
    });

    it('settles even when no exit ever follows it', async () => {
      // Node does not promise an 'exit' after an 'error'. If this promise
      // stayed pending, `yarn serve` would hang with the other half live.
      const { supervisor, orchestrator, dashboard } = start();

      orchestrator.emit('error', new Error('spawn EACCES'));
      dashboard.die(0);

      await expect(supervisor.done).resolves.toBe(1);
    });

    it('does not double-count when an exit follows it', async () => {
      const messages: string[] = [];
      const { supervisor, orchestrator, dashboard } = start((m) => messages.push(m));

      orchestrator.emit('error', new Error('spawn ENOENT'));
      orchestrator.die(7);
      dashboard.die(0);

      await expect(supervisor.done).resolves.toBe(1);
      expect(messages).toHaveLength(1);
    });
  });
});
