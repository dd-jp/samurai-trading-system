import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharedStorePath } from '../shared/store/index.js';
import { DEFAULT_WINDOW_DAYS, parseWindowDays, resolveDbPathFromArgv } from './cli-args.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseWindowDays', () => {
  it('defaults when --days is absent', () => {
    expect(parseWindowDays([])).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('reads a positive day count', () => {
    expect(parseWindowDays(['--days', '7'])).toBe(7);
  });

  it.each([['0'], ['-1'], ['x'], [undefined]])('refuses %j', (raw) => {
    const argv = raw === undefined ? ['--days'] : ['--days', raw];
    expect(() => parseWindowDays(argv)).toThrow('--days must be a positive number of days');
  });
});

describe('resolveDbPathFromArgv', () => {
  it('returns an explicit --db path that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samurai-cli-args-'));
    try {
      const dbPath = join(dir, 'store.sqlite');
      writeFileSync(dbPath, '');
      expect(resolveDbPathFromArgv(['--db', dbPath])).toBe(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an explicit --db path that does not exist', () => {
    expect(() => resolveDbPathFromArgv(['--db', '/nonexistent/samurai.sqlite'])).toThrow(
      'refusing to create a new database file',
    );
  });

  it('refuses --db without a path', () => {
    expect(() => resolveDbPathFromArgv(['--db'])).toThrow('--db requires a path argument.');
  });

  it("falls back to SAMURAI_MODE's shared store", () => {
    vi.stubEnv('SAMURAI_MODE', 'paper');
    expect(resolveDbPathFromArgv([])).toBe(sharedStorePath('paper'));
  });

  it('refuses when SAMURAI_MODE is unset', () => {
    vi.stubEnv('SAMURAI_MODE', '');
    expect(() => resolveDbPathFromArgv([])).toThrow('SAMURAI_MODE must be one of');
  });
});
