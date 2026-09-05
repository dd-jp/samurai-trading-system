import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_RETENTION_DAYS,
  isArchivedLogName,
  logRetentionDaysFromEnvironment,
  logRetentionKeepNamesFromEnvironment,
  sweepStaleLogs,
  sweepStaleLogsWithLog,
} from './log-retention.js';
import type { LogEntry } from './types.js';

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samurai-log-retention-'));
  outside = mkdtempSync(join(tmpdir(), 'samurai-log-retention-outside-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-04T12:00:00Z');

/** Backdates a file's mtime by `ageMs` relative to `NOW`, atime left alone. */
function age(path: string, ageMs: number): void {
  const seconds = (NOW - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

function write(path: string, content = 'x'.repeat(10)): string {
  writeFileSync(path, content);
  return path;
}

describe('sweepStaleLogs — age', () => {
  it('removes a file older than the retention window', () => {
    const stale = write(join(dir, 'old-20260101-0000.log'));
    age(stale, 10 * ONE_DAY_MS);

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    expect(result.filesRemoved).toBe(1);
    expect(result.bytesReclaimed).toBe(10);
    expect(() => statSync(stale)).toThrow();
  });

  it('keeps a file modified inside the retention window', () => {
    const fresh = write(join(dir, 'fresh-20260903-0000.log'));
    age(fresh, 2 * ONE_DAY_MS);

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(fresh).isFile()).toBe(true);
  });
});

describe('sweepStaleLogs — liveness', () => {
  // A rotation generation, not the undated `orchestrator.log`: an undated
  // bare name is ineligible by the name rule alone, which would leave
  // `protectedPaths` untested here.
  it('keeps a protected path even when it is old', () => {
    const active = write(join(dir, 'orchestrator.log.1'));
    age(active, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      protectedPaths: [active],
      now: () => NOW,
    });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(active).isFile()).toBe(true);
  });

  it('keeps a file whose identity matches an active descriptor, even when old', () => {
    const live = write(join(dir, 'supervisor-20260101-0000.log'));
    age(live, 100 * ONE_DAY_MS);
    const identity = statSync(live);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      now: () => NOW,
      activeDescriptors: () => [{ dev: identity.dev, ino: identity.ino }],
    });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(live).isFile()).toBe(true);
  });
});

describe('sweepStaleLogs — containment', () => {
  it('never touches a file outside the swept directory, even through a symlink', () => {
    const target = write(join(outside, 'do-not-touch-20260101-0000.log'));
    age(target, 100 * ONE_DAY_MS);
    const link = join(dir, 'linked-20260101-0000.log');
    symlinkSync(target, link);
    age(link, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    // The LINK's own survival is the assertion. `rmSync` on a symlink unlinks
    // the link and never the target, so a target still on disk is true under
    // every mutation and proves nothing; a swept link is the observable
    // difference between skipping the entry and resolving it.
    expect(result.filesRemoved).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('does not recurse into a subdirectory', () => {
    const nested = mkdirSync(join(dir, 'nested'), { recursive: true });
    const nestedFile = write(join(dir, 'nested', 'old-20260101-0000.log'));
    age(nestedFile, 100 * ONE_DAY_MS);
    void nested;

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(nestedFile).isFile()).toBe(true);
  });
});

describe('sweepStaleLogs — tolerance', () => {
  it('does not throw when a file cannot be removed, and does not count it', () => {
    const stale = write(join(dir, 'locked-20260101-0000.log'));
    age(stale, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      now: () => NOW,
      remove: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(result.filesRemoved).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
    expect(statSync(stale).isFile()).toBe(true);
  });

  it('does not throw when the directory is missing', () => {
    const result = sweepStaleLogs({
      directory: join(dir, 'does-not-exist'),
      maxAgeMs: 7 * ONE_DAY_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ filesRemoved: 0, bytesReclaimed: 0 });
  });
});

describe('sweepStaleLogsWithLog', () => {
  function makeLogger() {
    const entries: LogEntry[] = [];
    return { entries, log: (entry: LogEntry) => entries.push(entry) };
  }

  it('logs an info line naming what it swept when something was removed', () => {
    const stale = write(join(dir, 'old-20260101-0000.log'));
    age(stale, 10 * ONE_DAY_MS);
    const logger = makeLogger();

    const result = sweepStaleLogsWithLog(
      { directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW },
      logger,
    );

    expect(result.filesRemoved).toBe(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('info');
    expect(logger.entries[0]?.payload).toEqual({ files_removed: 1, bytes_reclaimed: 10 });
  });

  it('logs nothing when nothing was stale', () => {
    const fresh = write(join(dir, 'fresh-20260903-0000.log'));
    age(fresh, ONE_DAY_MS);
    const logger = makeLogger();

    sweepStaleLogsWithLog({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW }, logger);

    expect(logger.entries).toHaveLength(0);
  });

  it('reports a warn and does not throw when the sweep itself fails unexpectedly', () => {
    const logger = makeLogger();

    const result = sweepStaleLogsWithLog(
      {
        directory: dir,
        maxAgeMs: 7 * ONE_DAY_MS,
        now: () => {
          throw new Error('clock unavailable');
        },
      },
      logger,
    );

    expect(result).toEqual({ filesRemoved: 0, bytesReclaimed: 0 });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('warn');
  });
});

describe('sweepStaleLogs — eligible names', () => {
  it.each([
    'orchestrator.log.1',
    'orchestrator.log.12',
    'orchestrator-20260902-1842.log',
    'supervisor-20260904-1020-v3.log',
    'soak-boot-20260903-1007.out',
  ])('treats %s as a finished artefact', (name) => {
    expect(isArchivedLogName(name)).toBe(true);
  });

  it.each([
    'orchestrator.log',
    'service-api.log',
    'soak-boot.out',
    '.env.local',
    'LICENSE',
    'tsconfig.json',
    'orchestrator-2026.log',
  ])('treats %s as ineligible', (name) => {
    expect(isArchivedLogName(name)).toBe(false);
  });

  it('leaves an undated bare name alone however old it is', () => {
    const live = write(join(dir, 'service-api.log'));
    age(live, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(live).isFile()).toBe(true);
  });

  it('leaves a non-log file alone however old it is', () => {
    const secret = write(join(dir, '.env.local'));
    age(secret, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({ directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(secret).isFile()).toBe(true);
  });

  it('keeps a basename named in keepNames', () => {
    const kept = write(join(dir, 'supervisor-20260101-0000.log'));
    age(kept, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      keepNames: ['supervisor-20260101-0000.log'],
      now: () => NOW,
    });

    expect(result.filesRemoved).toBe(0);
    expect(statSync(kept).isFile()).toBe(true);
  });
});

describe('sweepStaleLogs — refused directories', () => {
  // `cwd` is injected rather than `process.chdir`-ed: a mutation that breaks
  // the refusal must sweep a temp directory, never the real repo root.
  it('refuses to sweep the process working directory and removes nothing', () => {
    const stale = write(join(dir, 'old-20260101-0000.log'));
    age(stale, 100 * ONE_DAY_MS);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      now: () => NOW,
      cwd: () => dir,
    });

    expect(result.filesRemoved).toBe(0);
    expect(result.refusedReason).toBeDefined();
    expect(statSync(stale).isFile()).toBe(true);
  });

  it('warns rather than throwing when the directory is refused', () => {
    const entries: LogEntry[] = [];
    const result = sweepStaleLogsWithLog(
      { directory: dir, maxAgeMs: 7 * ONE_DAY_MS, now: () => NOW, cwd: () => dir },
      { log: (entry: LogEntry) => entries.push(entry) },
    );

    expect(result.filesRemoved).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.message).toContain('refused');
  });
});

describe('logRetentionKeepNamesFromEnvironment', () => {
  it('is empty when unset', () => {
    expect(logRetentionKeepNamesFromEnvironment({})).toEqual([]);
  });

  it('parses and trims a comma-separated list', () => {
    expect(
      logRetentionKeepNamesFromEnvironment({
        SAMURAI_LOG_RETENTION_KEEP: 'soak-boot-20260903-1007.out, supervisor-20260101-0000.log',
      }),
    ).toEqual(['soak-boot-20260903-1007.out', 'supervisor-20260101-0000.log']);
  });

  it('treats a whitespace-only value as unset', () => {
    expect(logRetentionKeepNamesFromEnvironment({ SAMURAI_LOG_RETENTION_KEEP: '  ' })).toEqual([]);
  });

  it('refuses a stray comma rather than silently dropping the entry', () => {
    expect(() =>
      logRetentionKeepNamesFromEnvironment({ SAMURAI_LOG_RETENTION_KEEP: 'a.log,' }),
    ).toThrow(/empty entry/);
  });

  it('refuses a path, which would imply the sweep leaves its directory', () => {
    expect(() =>
      logRetentionKeepNamesFromEnvironment({ SAMURAI_LOG_RETENTION_KEEP: 'logs/a.log' }),
    ).toThrow(/basenames/);
  });
});

describe('logRetentionDaysFromEnvironment', () => {
  it('defaults when unset', () => {
    expect(logRetentionDaysFromEnvironment({})).toBe(DEFAULT_LOG_RETENTION_DAYS);
  });

  it('parses a configured value', () => {
    expect(logRetentionDaysFromEnvironment({ SAMURAI_LOG_RETENTION_DAYS: '5' })).toBe(5);
  });

  it.each(['abc', '0', '-1', '1.5', '1e400'])('refuses %s rather than defaulting', (raw) => {
    expect(() => logRetentionDaysFromEnvironment({ SAMURAI_LOG_RETENTION_DAYS: raw })).toThrow(
      /SAMURAI_LOG_RETENTION_DAYS/,
    );
  });

  it('treats an empty value as unset rather than as zero', () => {
    expect(logRetentionDaysFromEnvironment({ SAMURAI_LOG_RETENTION_DAYS: ' ' })).toBe(
      DEFAULT_LOG_RETENTION_DAYS,
    );
  });
});
