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

/** Backdates a file's mtime by `ageMs` relative to `NOW`, atime left alone */
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
  // `protectedPaths` untested here
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
    // difference between skipping the entry and resolving it
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
    // See the "byte threshold" test above: bytes_reclaimed reports disk
    // allocation, not apparent size, so it is computed rather than hardcoded
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
    // #1206: a bare date with no time component — the date's 8 digits run
    // straight into the extension's own dot, rather than into a `-`/`.`
    // separator followed by more characters
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
    // #1206: a long digit run with no `-`/`.` boundary after the first 8
    // digits must still fail to pass as a datestamp
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

// #1206: the retention sweep's OTHER path for an undated bare name
// (`soak-boot.out`) — truncation, never unlink, so the safety property in
// the module doc ("liveness rule") holds under a different mechanism rather
// than being bypassed. `bareTruncateNames` is passed explicitly throughout —
// unlike `bareTruncateBytes`, it has no default at this pure-function level
// (see the module doc) — matching how the real entrypoint always wires it
// via `logBareTruncateNamesFromEnvironment`
describe('sweepStaleLogs — bare-name truncation (#1206)', () => {
  it('truncates an allowlisted bare log-shaped file once it crosses the byte threshold', () => {
    const big = write(join(dir, 'soak-boot.out'), 'x'.repeat(200));
    // Eligibility and `bytesReclaimed` are computed from DISK ALLOCATION
    // (`stat.blocks * 512`), never `stat.size` — see MAJOR 2 in #1281's
    // review, and the module doc's "Bare live names" section for why
    // Computed from the real filesystem rather than hardcoded so this test
    // does not assume a particular block size
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

  // #1281 review round 2: the allowlist, not the threshold, is what scopes
  // this path's blast radius now. `install.log` is a real macOS system log
  // the round-1 review found matching the old, unscoped predicate — this
  // proves the shape check (`isBareLogName`) alone is no longer sufficient
  // for eligibility, whatever the threshold or the file's actual size
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

  // Defense in depth: an allowlisted name that is not log-shaped (an
  // operator's own `SAMURAI_LOG_BARE_TRUNCATE_NAMES` entry could name
  // anything) still never reaches truncation — `isBareLogName` and the
  // allowlist are independent gates, both required
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
    // The fixture is written first and the threshold derived FROM its actual
    // allocation, rather than hardcoding a byte count: eligibility is
    // allocation-based (`stat.blocks * 512`, see the test above), and a
    // filesystem's block size is its own to pick, so a hardcoded threshold
    // risks landing on the wrong side of "under" on a filesystem with a
    // larger block than this repo's two target filesystems (4 KiB on both)
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
    // Contrast with the unlink path's liveness rule: unlink on the process's
    // own open file is exactly the hazard that rule exists to prevent, but
    // truncate has no such hazard, so a live descriptor match is not a
    // reason to skip it here
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

  // The crux of #1206: unlinking a file a writer still holds open makes
  // growth invisible (the inode survives, detached from any path, until the
  // writer exits). This proves truncation cannot do that — the SAME open
  // descriptor a live writer would hold keeps working, and its next write is
  // reachable again by path, not stranded on an unlinked inode
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

    // The same fd the "writer" opened before the sweep ran is still valid —
    // an unlinked file's fd would still accept this write too, but the
    // content would then be unreachable by `path` once the fd closes, which
    // is exactly what the next assertion rules out
    writeSync(fd, Buffer.from('still-writing'));
    closeSync(fd);

    expect(readFileSync(path, 'utf8')).toContain('still-writing');
  });

  // A non-append fd (exactly what `> logs/soak-boot.out 2>&1` opens — no
  // `O_APPEND`, unlike `>>`) keeps writing at its OWN offset, which truncate
  // does not move. So the next write lands where the 200 bytes used to be,
  // not at the new (zero) end of file: a 200-byte hole precedes it (bytes
  // 0..199), and `stat.size` reports 213 (200 + the 13-byte write) again,
  // not 13. Liveness still holds (the prior test's `still-writing` is
  // readable), but this is why eligibility and `bytesReclaimed` are gated on
  // DISK ALLOCATION (`stat.blocks`), never `stat.size` — see the field's own
  // doc comment and the MAJOR-2-regression test below
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
    // Confirms truncation actually ran, distinct from the final size below:
    // without this, a no-op `truncate` would reach the same 213 by simply
    // never shrinking the file, since the fd's offset was already 200
    expect(statSync(path).size).toBe(0);

    writeSync(fd, Buffer.from('still-writing'));
    closeSync(fd);

    expect(statSync(path).size).toBe(213);
    // The hole, not a coincidence of size: bytes 0..199 are NUL (the hole),
    // and only the region the second write actually touched holds new data
    const content = readFileSync(path);
    expect(content.subarray(0, 200).every((byte) => byte === 0)).toBe(true);
    expect(content.subarray(200).toString('utf8')).toBe('still-writing');
  });

  // MAJOR 2, #1281 review: gating on `stat.size` instead of `stat.blocks`
  // would see the SAME recovered apparent size the previous test measures,
  // conclude the file is still oversized, and truncate again on every
  // subsequent boot — destroying whatever the live writer had appended since
  // the last one, forever, for as long as it stays open. Sizes here are
  // deliberately much larger than one filesystem block (4 KiB in this repo's
  // two target filesystems, macOS APFS and Linux ext4) so the "recovered"
  // footprint after a hole-punch (a handful of KiB) is unambiguously smaller
  // than the threshold, the way `DEFAULT_BARE_TRUNCATE_BYTES` (16 MiB) is in
  // production — a threshold near one block's own size would not
  // discriminate the fix from the bug either way
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

    // Same fd, still open: its next write lands at the stale ~2 MiB offset,
    // not at the new end of file, so `stat.size` balloons back past the
    // threshold even though almost nothing is actually allocated on disk —
    // exactly the state that would fool a size-based gate into re-truncating
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

// #1281 review, round 2: this setting has the same default posture as every
// other setting in this module now — `bareTruncateNames`
// (`logBareTruncateNamesFromEnvironment` below), not this threshold, is what
// scopes the truncate path's blast radius. An earlier revision made this
// opt-in instead (unset meant disabled); that closed the blast-radius hazard
// but left `soak-boot.out` unbounded in every deployment that never set the
// variable, which — grepped across this repo — was all of them. See the
// module doc's "Bare live names" section
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

// #1281 review, round 2: the truncate path's name-based narrowing
// `DEFAULT_BARE_TRUNCATE_NAMES` (`soak-boot.out` alone) is what makes the
// default-on threshold above safe — `install.log`/`wifi.log`/`system.log`
// are unreachable by construction, not by an operator remembering to opt
// out. This variable only ever ADDS to that default, never replaces it —
// `SAMURAI_LOG_RETENTION_KEEP` already exempts any specific file, truncation
// included, so there is no separate way to shrink this list
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
  // `cwd` is injected rather than `process.chdir`-ed: a mutation that breaks
  // the refusal must sweep a temp directory, never the real repo root
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
