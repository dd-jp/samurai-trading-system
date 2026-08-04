import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_FILE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROTATED_FILES,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samurai-log-sink-'));
});

afterEach(() => {
  // 0o000 directories are created by the degrade tests; make them removable.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Already removable.
  }
  rmSync(dir, { recursive: true, force: true });
});

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean);

describe('RotatingFileSink — writing', () => {
  it('appends each line to the configured file, creating the directory', () => {
    const filePath = join(dir, 'nested', 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 1024, maxRotatedFiles: 2 });

    sink.write('{"a":1}\n');
    sink.write('{"a":2}\n');
    sink.close();

    expect(lines(filePath)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('appends to an existing file rather than truncating it', () => {
    const filePath = join(dir, 'orchestrator.log');
    const first = new RotatingFileSink({ filePath, maxBytes: 1024, maxRotatedFiles: 2 });
    first.write('{"run":1}\n');
    first.close();

    const second = new RotatingFileSink({ filePath, maxBytes: 1024, maxRotatedFiles: 2 });
    second.write('{"run":2}\n');
    second.close();

    expect(lines(filePath)).toEqual(['{"run":1}', '{"run":2}']);
  });

  it('creates the log file owner-readable only', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 1024, maxRotatedFiles: 2 });
    sink.write('{"a":1}\n');
    sink.close();

    // SECURITY: log payloads are the most detailed record this process keeps.
    // 0o600 on creation keeps them off a shared host's other accounts.
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('counts bytes, not UTF-16 code units, when deciding to rotate', () => {
    const filePath = join(dir, 'orchestrator.log');
    // Four 4-byte astral characters + newline = 17 bytes; `.length` says 9.
    const line = `${'𝕊𝕒𝕞𝕦'}\n`;
    expect(line.length).toBeLessThan(Buffer.byteLength(line));

    const sink = new RotatingFileSink({ filePath, maxBytes: 20, maxRotatedFiles: 2 });
    sink.write(line);
    sink.write(line);
    sink.close();

    // Byte-accurate accounting rotates after the first line (17 + 17 > 20).
    // A `.length`-based counter would think 9 + 9 <= 20 and never rotate.
    expect(lines(`${filePath}.1`)).toEqual(['𝕊𝕒𝕞𝕦']);
    expect(lines(filePath)).toEqual(['𝕊𝕒𝕞𝕦']);
  });
});

describe('RotatingFileSink — rotation and retention', () => {
  it('rotates to .1 and shifts older generations up', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxRotatedFiles: 3 });

    sink.write('aaaaaaaaa\n'); // 10 bytes — fills the active file exactly.
    sink.write('bbbbbbbbb\n');
    sink.write('ccccccccc\n');
    sink.close();

    expect(lines(filePath)).toEqual(['ccccccccc']);
    expect(lines(`${filePath}.1`)).toEqual(['bbbbbbbbb']);
    expect(lines(`${filePath}.2`)).toEqual(['aaaaaaaaa']);
  });

  it('never keeps more than maxRotatedFiles rotated generations', () => {
    const filePath = join(dir, 'orchestrator.log');
    const maxRotatedFiles = 2;
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxRotatedFiles });

    // Well past the cap: 6 lines is 5 rotations against a cap of 2.
    for (const marker of ['a', 'b', 'c', 'd', 'e', 'f']) {
      sink.write(`${marker.repeat(9)}\n`);
    }
    sink.close();

    // Exactly the active file plus the cap — nothing else, ever.
    expect(readdirSync(dir).sort()).toEqual([
      'orchestrator.log',
      'orchestrator.log.1',
      'orchestrator.log.2',
    ]);
    // And the survivors are the NEWEST, not the oldest.
    expect(lines(filePath)).toEqual(['fffffffff']);
    expect(lines(`${filePath}.1`)).toEqual(['eeeeeeeee']);
    expect(lines(`${filePath}.2`)).toEqual(['ddddddddd']);
  });

  it('does not rotate an empty active file, so an over-long line still lands', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 4, maxRotatedFiles: 2 });

    sink.write('a-line-far-longer-than-the-limit\n');
    sink.close();

    expect(lines(filePath)).toEqual(['a-line-far-longer-than-the-limit']);
    expect(readdirSync(dir)).toEqual(['orchestrator.log']);
  });

  it('rotates cleanly when older generations are missing', () => {
    // renameSync on an absent path throws ENOENT; a gap in the sequence (an
    // operator deleted .1 by hand mid-soak) must not take the sink down.
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxRotatedFiles: 4 });

    sink.write('aaaaaaaaa\n');
    sink.write('bbbbbbbbb\n');
    rmSync(`${filePath}.1`);
    sink.write('ccccccccc\n');
    sink.close();

    expect(sink.degraded).toBe(false);
    expect(lines(filePath)).toEqual(['ccccccccc']);
    expect(lines(`${filePath}.1`)).toEqual(['bbbbbbbbb']);
  });
});

describe('RotatingFileSink — degradation (never throws into a tick)', () => {
  it('degrades to stdout-only when the log directory cannot be created', () => {
    const unwritable = join(dir, 'locked');
    mkdirSync(unwritable, { mode: 0o500 });
    const failures: string[] = [];

    const sink = new RotatingFileSink({
      filePath: join(unwritable, 'sub', 'orchestrator.log'),
      maxBytes: 1024,
      maxRotatedFiles: 2,
      onFailure: (message) => failures.push(message),
    });

    expect(sink.degraded).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/orchestrator\.log/);
  });

  it('does not throw, and reports once, when writes keep failing', () => {
    const filePath = join(dir, 'orchestrator.log');
    const failures: string[] = [];
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1024,
      maxRotatedFiles: 2,
      onFailure: (message) => failures.push(message),
      // The seam that stands in for a full disk / revoked fd mid-run.
      writeLine: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(() => {
      sink.write('{"tick":1}\n');
      sink.write('{"tick":2}\n');
      sink.write('{"tick":3}\n');
    }).not.toThrow();

    expect(sink.degraded).toBe(true);
    // Once — not once per tick. A 14-day soak on a full disk must not turn
    // stdout into the same flood that filled the disk.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ENOSPC');
    expect(failures[0]).toMatch(/until the process is restarted/i);
  });

  it('stops touching the filesystem once degraded', () => {
    const filePath = join(dir, 'orchestrator.log');
    let attempts = 0;
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1024,
      maxRotatedFiles: 2,
      onFailure: () => {},
      writeLine: () => {
        attempts += 1;
        throw new Error('EIO');
      },
    });

    sink.write('{"tick":1}\n');
    sink.write('{"tick":2}\n');
    sink.write('{"tick":3}\n');

    expect(attempts).toBe(1);
  });

  it('never throws from close(), even when already degraded', () => {
    const sink = new RotatingFileSink({
      filePath: join(dir, 'orchestrator.log'),
      maxBytes: 1024,
      maxRotatedFiles: 2,
    });
    sink.write('{"a":1}\n');

    expect(() => {
      sink.close();
      sink.close();
    }).not.toThrow();
  });
});

describe('fileSinkConfigFromEnvironment', () => {
  const KEYS = ['SAMURAI_LOG_FILE', 'SAMURAI_LOG_MAX_BYTES', 'SAMURAI_LOG_MAX_FILES'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to an in-repo-adjacent path with a bounded retention', () => {
    expect(fileSinkConfigFromEnvironment()).toEqual({
      filePath: DEFAULT_LOG_FILE,
      maxBytes: DEFAULT_MAX_BYTES,
      maxRotatedFiles: DEFAULT_MAX_ROTATED_FILES,
    });
  });

  it('caps total on-disk log at a bounded, documented size by default', () => {
    // The retention window is deliberately short: the durable trade record is
    // SQLite, not this file (CLAUDE.md / UK CGT). Guard against a future edit
    // quietly making the default unbounded-ish.
    const cap = DEFAULT_MAX_BYTES * (DEFAULT_MAX_ROTATED_FILES + 1);
    expect(cap).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  it('reads path and rotation policy off the environment', () => {
    process.env.SAMURAI_LOG_FILE = '/var/log/samurai/orchestrator.log';
    process.env.SAMURAI_LOG_MAX_BYTES = '1048576';
    process.env.SAMURAI_LOG_MAX_FILES = '3';

    expect(fileSinkConfigFromEnvironment()).toEqual({
      filePath: '/var/log/samurai/orchestrator.log',
      maxBytes: 1_048_576,
      maxRotatedFiles: 3,
    });
  });

  it.each([
    ['SAMURAI_LOG_MAX_BYTES', 'plenty'],
    ['SAMURAI_LOG_MAX_BYTES', '0'],
    ['SAMURAI_LOG_MAX_BYTES', '-1'],
    ['SAMURAI_LOG_MAX_BYTES', '1.5'],
    ['SAMURAI_LOG_MAX_FILES', 'lots'],
    ['SAMURAI_LOG_MAX_FILES', '-1'],
  ])('refuses a malformed %s=%s at startup, naming the variable', (key, value) => {
    process.env[key] = value;
    // Config errors fail fast (parseMode / sharedStorePath posture); only
    // runtime I/O failures degrade.
    expect(() => fileSinkConfigFromEnvironment()).toThrow(new RegExp(key));
  });

  it('accepts SAMURAI_LOG_MAX_FILES=0 as "rotate by truncation, keep nothing"', () => {
    process.env.SAMURAI_LOG_MAX_FILES = '0';
    expect(fileSinkConfigFromEnvironment().maxRotatedFiles).toBe(0);
  });

  it('treats an empty value as unset rather than as an empty path', () => {
    process.env.SAMURAI_LOG_FILE = '';
    expect(fileSinkConfigFromEnvironment().filePath).toBe(DEFAULT_LOG_FILE);
  });
});

describe('RotatingFileSink — maxRotatedFiles=0', () => {
  it('discards the previous generation instead of keeping it', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxRotatedFiles: 0 });

    sink.write('aaaaaaaaa\n');
    sink.write('bbbbbbbbb\n');
    sink.close();

    expect(readdirSync(dir)).toEqual(['orchestrator.log']);
    expect(lines(filePath)).toEqual(['bbbbbbbbb']);
  });
});
