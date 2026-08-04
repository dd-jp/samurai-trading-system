import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEntrypointLogger, JsonLogger } from './logger.js';

let dir: string;
let stdout: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samurai-logger-'));
  stdout = [];
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Already removable.
  }
  rmSync(dir, { recursive: true, force: true });
});

const ENTRY = {
  trace_id: 'trace-1',
  stage: 'trader',
  level: 'info' as const,
  message: 'decided',
  payload: { direction: 'long' },
};

describe('JsonLogger', () => {
  it('writes one JSON line per call to stdout', () => {
    new JsonLogger().log(ENTRY);

    expect(stdout).toHaveLength(1);
    expect(stdout[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(stdout[0])).toMatchObject({
      trace_id: 'trace-1',
      stage: 'trader',
      level: 'info',
      message: 'decided',
      payload: { direction: 'long' },
    });
    expect(typeof JSON.parse(stdout[0]).timestamp).toBe('string');
  });

  it('writes the identical line to the file sink as well as stdout', () => {
    const written: string[] = [];
    new JsonLogger({ write: (line) => written.push(line) }).log(ENTRY);

    // Both, not either — a foreground run stays readable while the soak gets
    // its durable trace.
    expect(written).toEqual(stdout);
  });

  it('keeps logging to stdout when the sink throws, and never throws itself', () => {
    // The requirement that must not be got wrong: a sink failure is not
    // allowed to propagate into a tick.
    const logger = new JsonLogger({
      write: () => {
        throw new Error('EIO');
      },
    });

    expect(() => {
      logger.log(ENTRY);
      logger.log(ENTRY);
    }).not.toThrow();

    const parsed = stdout.map((line) => JSON.parse(line));
    // Both entries still reached stdout...
    expect(parsed.filter((e) => e.message === 'decided')).toHaveLength(2);
    // ...plus exactly one warn about the sink, not one per line.
    const warns = parsed.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/sink/i);
  });

  it('does not route the sink-failure warn back through the sink', () => {
    // Otherwise the degradation warn is the thing that recurses.
    let attempts = 0;
    new JsonLogger({
      write: () => {
        attempts += 1;
        throw new Error('EIO');
      },
    }).log(ENTRY);

    expect(attempts).toBe(1);
  });
});

describe('buildEntrypointLogger', () => {
  it('leaves a durable file behind with the logged lines in it', () => {
    const filePath = join(dir, 'orchestrator.log');
    const logger = buildEntrypointLogger({ filePath, maxBytes: 4096, maxRotatedFiles: 2 });

    logger.log(ENTRY);

    const [line] = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(line)).toMatchObject({ trace_id: 'trace-1', message: 'decided' });
    // And stdout is unchanged — this is a second sink, not a replacement.
    expect(stdout.map((s) => JSON.parse(s).message)).toEqual(['decided']);
  });

  it('degrades to stdout with a warn when the path is unwritable', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked, { mode: 0o500 });

    const logger = buildEntrypointLogger({
      filePath: join(locked, 'nested', 'orchestrator.log'),
      maxBytes: 4096,
      maxRotatedFiles: 2,
    });

    // The construction warn is a proper structured line on stdout...
    const warn = stdout.map((s) => JSON.parse(s)).find((e) => e.level === 'warn');
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/log file sink disabled/i);
    expect(warn.stage).toBe('orchestrator');

    // ...and the process keeps logging.
    expect(() => logger.log(ENTRY)).not.toThrow();
    expect(stdout.map((s) => JSON.parse(s).message)).toContain('decided');
  });

  it('reads its configuration from the environment when none is passed', () => {
    const filePath = join(dir, 'from-env', 'orchestrator.log');
    const saved = process.env.SAMURAI_LOG_FILE;
    process.env.SAMURAI_LOG_FILE = filePath;

    try {
      buildEntrypointLogger().log(ENTRY);
      expect(readFileSync(filePath, 'utf8')).toContain('"trace_id":"trace-1"');
    } finally {
      if (saved === undefined) delete process.env.SAMURAI_LOG_FILE;
      else process.env.SAMURAI_LOG_FILE = saved;
    }
  });
});
