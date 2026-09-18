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
  writeAll,
} from './rotating-file-sink.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samurai-log-sink-'));
});

afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
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

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('counts bytes, not UTF-16 code units, when deciding to rotate', () => {
    const filePath = join(dir, 'orchestrator.log');
    const line = `${'𝕊𝕒𝕞𝕦'}\n`;
    expect(line.length).toBeLessThan(Buffer.byteLength(line));

    const sink = new RotatingFileSink({ filePath, maxBytes: 20, maxRotatedFiles: 2 });
    sink.write(line);
    sink.write(line);
    sink.close();

    expect(lines(`${filePath}.1`)).toEqual(['𝕊𝕒𝕞𝕦']);
    expect(lines(filePath)).toEqual(['𝕊𝕒𝕞𝕦']);
  });
});

describe('RotatingFileSink — rotation and retention', () => {
  it('rotates to .1 and shifts older generations up', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxRotatedFiles: 3 });

    sink.write('aaaaaaaaa\n');
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

    for (const marker of ['a', 'b', 'c', 'd', 'e', 'f']) {
      sink.write(`${marker.repeat(9)}\n`);
    }
    sink.close();

    expect(readdirSync(dir).sort()).toEqual([
      'orchestrator.log',
      'orchestrator.log.1',
      'orchestrator.log.2',
    ]);
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

  it('does not let a throwing onFailure escape into the caller', () => {
    const filePath = join(dir, 'orchestrator.log');
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1024,
      maxRotatedFiles: 2,
      onFailure: () => {
        throw new Error('EPIPE: broken pipe');
      },
      writeLine: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(() => sink.write('{"tick":1}\n')).not.toThrow();
    expect(sink.degraded).toBe(true);
    expect(() => sink.write('{"tick":2}\n')).not.toThrow();
  });

  it('does not let a throwing onFailure escape the constructor', () => {
    const unwritable = join(dir, 'locked-2');
    mkdirSync(unwritable, { mode: 0o500 });

    expect(
      () =>
        new RotatingFileSink({
          filePath: join(unwritable, 'sub', 'orchestrator.log'),
          maxBytes: 1024,
          maxRotatedFiles: 2,
          onFailure: () => {
            throw new Error('EPIPE: broken pipe');
          },
        }),
    ).not.toThrow();
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

describe('writeAll — partial writes and the zero-progress guard', () => {
  it('drains the buffer across partial writes', () => {
    const bytes = Buffer.from('abcdefghij', 'utf8');
    const chunks: string[] = [];
    writeAll(7, bytes, (_fd, buffer, offset, length) => {
      const take = Math.min(3, length);
      chunks.push(buffer.subarray(offset, offset + take).toString('utf8'));
      return take;
    });

    expect(chunks).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('throws instead of spinning when a write makes no progress', () => {
    expect(() => writeAll(7, Buffer.from('abc', 'utf8'), () => 0)).toThrow(/no progress/i);
  });

  it('degrades the sink rather than hanging it when writes make no progress', () => {
    const sink = new RotatingFileSink({
      filePath: join(dir, 'orchestrator.log'),
      maxBytes: 1024,
      maxRotatedFiles: 2,
      onFailure: () => {},
      writeLine: (fd, bytes) => writeAll(fd, bytes, () => 0),
    });

    expect(() => sink.write('{"tick":1}\n')).not.toThrow();
    expect(sink.degraded).toBe(true);
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

  it('treats a whitespace-only value as unset, not as a path made of spaces', () => {
    process.env.SAMURAI_LOG_FILE = '   ';
    expect(fileSinkConfigFromEnvironment().filePath).toBe(DEFAULT_LOG_FILE);
  });

  it('never reads a whitespace-only SAMURAI_LOG_MAX_FILES as 0', () => {
    process.env.SAMURAI_LOG_MAX_FILES = ' ';
    const config = fileSinkConfigFromEnvironment();

    expect(config.maxRotatedFiles).not.toBe(0);
    expect(config.maxRotatedFiles).toBe(DEFAULT_MAX_ROTATED_FILES);
  });

  it('treats a whitespace-only SAMURAI_LOG_MAX_BYTES as unset too', () => {
    process.env.SAMURAI_LOG_MAX_BYTES = '\t';
    expect(fileSinkConfigFromEnvironment().maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it('still accepts a value with incidental surrounding whitespace', () => {
    process.env.SAMURAI_LOG_MAX_FILES = ' 3 ';
    expect(fileSinkConfigFromEnvironment().maxRotatedFiles).toBe(3);
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
