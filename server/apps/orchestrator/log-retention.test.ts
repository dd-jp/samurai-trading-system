import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BARE_TRUNCATE_BYTES,
  DEFAULT_BARE_TRUNCATE_NAMES,
  DEFAULT_LOG_RETENTION_DAYS,
  isArchivedLogName,
  isBareLogName,
  logBareTruncateBytesFromEnvironment,
  logBareTruncateNamesFromEnvironment,
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

    expect(result).toEqual({ filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 });
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
    expect(logger.entries[0]?.payload).toEqual({
      files_removed: 1,
      files_truncated: 0,
      bytes_reclaimed: 10,
    });
  });

  it('logs an info line when only a bare file was truncated, no file removed', () => {
    const big = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));
    const allocatedBytes = statSync(big).blocks * 512;
    const logger = makeLogger();

    const result = sweepStaleLogsWithLog(
      {
        directory: dir,
        maxAgeMs: 7 * ONE_DAY_MS,
        bareTruncateBytes: 100,
        bareTruncateNames: ['soak-boot.out'],
        now: () => NOW,
      },
      logger,
    );

    expect(result.filesRemoved).toBe(0);
    expect(result.filesTruncated).toBe(1);
    expect(statSync(big).size).toBe(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('info');
    expect(logger.entries[0]?.payload).toEqual({
      files_removed: 0,
      files_truncated: 1,
      bytes_reclaimed: allocatedBytes,
    });
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

    expect(result).toEqual({ filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 });
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
    'soak-20260825.log',
    'orchestrator-20260825.log',
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
    'orchestrator-202608251842.log',
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

describe('isBareLogName (#1206)', () => {
  it.each(['orchestrator.log', 'service-api.log', 'soak-boot.out'])('treats %s as bare', (name) => {
    expect(isBareLogName(name)).toBe(true);
  });

  it.each([
    'orchestrator.log.1',
    'orchestrator-20260902-1842.log',
    'soak-20260825.log',
    '.env.local',
    'LICENSE',
    'tsconfig.json',
  ])('treats %s as not bare', (name) => {
    expect(isBareLogName(name)).toBe(false);
  });
});

describe('sweepStaleLogs — bare-name truncation (#1206)', () => {
  it('truncates an allowlisted bare log-shaped file once it crosses the byte threshold', () => {
    const big = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));
    const allocatedBytes = statSync(big).blocks * 512;

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(1);
    expect(result.bytesReclaimed).toBe(allocatedBytes);
    expect(statSync(big).size).toBe(0);
  });

  it('never truncates a bare .log/.out file outside the allowlist, however large', () => {
    const other = write(join(dir, 'install.log'), 'x'.repeat(2 * 1024 * 1024));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(other).size).toBe(2 * 1024 * 1024);
  });

  it('never truncates an allowlisted name that is not log-shaped', () => {
    const secret = write(join(dir, '.env.local'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['.env.local'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(secret).size).toBe(200);
  });

  it('leaves an allowlisted bare file under the threshold alone', () => {
    const small = write(join(dir, 'soak-boot.out'), 'x'.repeat(50));
    const threshold = statSync(small).blocks * 512 + 1;

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: threshold,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(small).size).toBe(50);
  });

  it('never truncates a bare file when no threshold is configured', () => {
    const big = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(big).size).toBe(200);
  });

  it('never truncates a bare file when no allowlist is configured', () => {
    const big = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(big).size).toBe(200);
  });

  it('never truncates a non-log file, however large, because it is not log-shaped', () => {
    const secret = write(join(dir, '.env.local'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['.env.local'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(secret).size).toBe(200);
  });

  it("respects protectedPaths for a bare name too — the active sink's own file", () => {
    const active = write(join(dir, 'orchestrator.log'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['orchestrator.log'],
      protectedPaths: [active],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(active).size).toBe(200);
  });

  it('respects keepNames for a bare name too', () => {
    const kept = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      keepNames: ['soak-boot.out'],
      now: () => NOW,
    });

    expect(result.filesTruncated).toBe(0);
    expect(statSync(kept).size).toBe(200);
  });

  it('truncates a bare name even when its identity matches an active descriptor', () => {
    const live = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));
    const identity = statSync(live);

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
      activeDescriptors: () => [{ dev: identity.dev, ino: identity.ino }],
    });

    expect(result.filesTruncated).toBe(1);
    expect(statSync(live).size).toBe(0);
  });

  it("keeps a live writer's descriptor usable, and its next write reachable by path", () => {
    const path = join(dir, 'soak-boot.out');
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('x'.repeat(200)));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });
    expect(result.filesTruncated).toBe(1);

    writeSync(fd, Buffer.from('still-writing'));
    closeSync(fd);

    expect(readFileSync(path, 'utf8')).toContain('still-writing');
  });

  it('reports apparent size that grows back through the hole a non-appending writer leaves', () => {
    const path = join(dir, 'soak-boot.out');
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('x'.repeat(200)));

    const result = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: 100,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });
    expect(result.filesTruncated).toBe(1);
    expect(statSync(path).size).toBe(0);

    writeSync(fd, Buffer.from('still-writing'));
    closeSync(fd);

    expect(statSync(path).size).toBe(213);
    const content = readFileSync(path);
    expect(content.subarray(0, 200).every((byte) => byte === 0)).toBe(true);
    expect(content.subarray(200).toString('utf8')).toBe('still-writing');
  });

  it('does not re-truncate, and does not destroy new output, once disk usage is already reclaimed', () => {
    const path = join(dir, 'soak-boot.out');
    const threshold = 1 * 1024 * 1024;
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('x'.repeat(2 * 1024 * 1024)));

    const boot1 = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: threshold,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });
    expect(boot1.filesTruncated).toBe(1);

    writeSync(fd, Buffer.from('still-alive-after-boot-1'));
    expect(statSync(path).size).toBeGreaterThan(threshold);

    const boot2 = sweepStaleLogs({
      directory: dir,
      maxAgeMs: 7 * ONE_DAY_MS,
      bareTruncateBytes: threshold,
      bareTruncateNames: ['soak-boot.out'],
      now: () => NOW,
    });
    expect(boot2.filesTruncated).toBe(0);

    writeSync(fd, Buffer.from('-still-here'));
    closeSync(fd);
    expect(readFileSync(path, 'utf8')).toContain('still-alive-after-boot-1-still-here');
  });
});

describe('logBareTruncateBytesFromEnvironment', () => {
  it('defaults to DEFAULT_BARE_TRUNCATE_BYTES when unset', () => {
    expect(logBareTruncateBytesFromEnvironment({})).toBe(DEFAULT_BARE_TRUNCATE_BYTES);
  });

  it('parses a configured value', () => {
    expect(logBareTruncateBytesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_BYTES: '512' })).toBe(
      512,
    );
  });

  it.each(['abc', '0', '-1', '1.5', '1e400'])('refuses %s rather than defaulting', (raw) => {
    expect(() =>
      logBareTruncateBytesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_BYTES: raw }),
    ).toThrow(/SAMURAI_LOG_BARE_TRUNCATE_BYTES/);
  });

  it('treats an empty value as unset (default) rather than as zero', () => {
    expect(logBareTruncateBytesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_BYTES: ' ' })).toBe(
      DEFAULT_BARE_TRUNCATE_BYTES,
    );
  });
});

describe('logBareTruncateNamesFromEnvironment (#1206 review, round 2)', () => {
  it('defaults to soak-boot.out alone when unset', () => {
    expect(logBareTruncateNamesFromEnvironment({})).toEqual(DEFAULT_BARE_TRUNCATE_NAMES);
  });

  it('extends the default with a single operator-provided name', () => {
    expect(
      logBareTruncateNamesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_NAMES: 'custom.out' }),
    ).toEqual(['soak-boot.out', 'custom.out']);
  });

  it('extends the default with multiple comma-separated names', () => {
    expect(
      logBareTruncateNamesFromEnvironment({
        SAMURAI_LOG_BARE_TRUNCATE_NAMES: 'custom.out, other.log',
      }),
    ).toEqual(['soak-boot.out', 'custom.out', 'other.log']);
  });

  it('refuses an empty entry (a stray or trailing comma)', () => {
    expect(() =>
      logBareTruncateNamesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_NAMES: 'custom.out,' }),
    ).toThrow(/SAMURAI_LOG_BARE_TRUNCATE_NAMES/);
  });

  it('refuses an entry that is a path rather than a basename', () => {
    expect(() =>
      logBareTruncateNamesFromEnvironment({
        SAMURAI_LOG_BARE_TRUNCATE_NAMES: 'sub/custom.out',
      }),
    ).toThrow(/SAMURAI_LOG_BARE_TRUNCATE_NAMES/);
  });

  it('treats an empty value as unset (default) rather than an empty list', () => {
    expect(logBareTruncateNamesFromEnvironment({ SAMURAI_LOG_BARE_TRUNCATE_NAMES: ' ' })).toEqual(
      DEFAULT_BARE_TRUNCATE_NAMES,
    );
  });
});

describe('sweepStaleLogs — refused directories', () => {
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
