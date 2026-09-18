import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { openSharedStore, sharedStorePath } from '../../shared/store/index.js';
import { JsonLogger } from '../orchestrator/index.js';

export type SpawnFn = (command: string, args: readonly string[]) => ChildProcess;

type SupervisedChild = Pick<ChildProcess, 'kill'> & {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
};

function migrateSharedStore(): void {
  const db = openSharedStore(sharedStorePath());
  db.close();
}

export interface SupervisorEffects {
  spawn?: SpawnFn;
  execPath?: string;
  scripts?: { orchestrator: string; dashboard: string };
  nodeArgs?: readonly string[];
  log?: (message: string) => void;
  prepare?: () => void;
}

export interface Supervisor {
  shutdown(signal: NodeJS.Signals): void;
  readonly done: Promise<number>;
}

const DEFAULT_SCRIPTS = {
  orchestrator: 'dist/server/apps/orchestrator/index.js',
  dashboard: 'dist/server/apps/service-api/index.js',
} as const;

const DEFAULT_NODE_ARGS = ['--env-file=.env.local'] as const;

const REQUESTED_STOP: ReadonlySet<string> = new Set(['SIGINT', 'SIGTERM']);

function isRequestedStop(shuttingDown: boolean, signal: NodeJS.Signals | null): boolean {
  return shuttingDown || (signal !== null && REQUESTED_STOP.has(signal));
}

function exitCodeForChildExit(code: number | null, requested: boolean, exitCode: number): number {
  if (!requested) {
    return code === null || code === 0 ? 1 : code;
  }
  if (code !== null && code !== 0 && exitCode === 0) {
    return code;
  }
  return exitCode;
}

const supervisorLogger = new JsonLogger();

export function startSupervisor(effects: SupervisorEffects = {}): Supervisor {
  const spawn: SpawnFn =
    effects.spawn ?? ((command, args) => nodeSpawn(command, [...args], { stdio: 'inherit' }));
  const execPath = effects.execPath ?? process.execPath;
  const scripts = effects.scripts ?? DEFAULT_SCRIPTS;
  const nodeArgs = effects.nodeArgs ?? DEFAULT_NODE_ARGS;
  const log =
    effects.log ??
    ((message: string) => {
      supervisorLogger.log({
        trace_id: 'startup',
        stage: 'supervisor',
        event: 'supervisor_notice',
        level: 'warn',
        message,
      });
    });

  (effects.prepare ?? migrateSharedStore)();

  let shuttingDown = false;
  let exitCode = 0;

  const running = new Map<string, SupervisedChild>();
  const exits: Promise<void>[] = [];

  for (const name of ['orchestrator', 'dashboard'] as const) {
    let child: SupervisedChild;
    try {
      child = spawn(execPath, [...nodeArgs, scripts[name]]);
    } catch (error) {
      shutdown('SIGTERM');
      throw error;
    }
    running.set(name, child);

    exits.push(
      new Promise<void>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          running.delete(name);
          shutdown('SIGTERM');
          resolve();
        };

        child.once('exit', (code, signal) => {
          const requested = isRequestedStop(shuttingDown, signal);

          if (!settled) {
            if (!requested) {
              log(`${name} exited (${signal ?? `code ${code ?? 'unknown'}`}); stopping the other.`);
            }
            exitCode = exitCodeForChildExit(code, requested, exitCode);
          }

          settle();
        });

        child.once('error', (error) => {
          if (!settled) {
            if (exitCode === 0) exitCode = 1;
            log(`${name} failed: ${error.message}; stopping the other.`);
          }
          settle();
        });
      }),
    );
  }

  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of running.values()) child.kill(signal);
  }

  return {
    shutdown,
    done: Promise.all(exits).then(() => exitCode),
  };
}
