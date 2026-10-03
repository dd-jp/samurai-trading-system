import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTokenFile } from './saxo-token-file.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const RECORD = {
  environment: 'sim',
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  accessTokenExpiresAt: '2026-10-03T12:20:00.000Z',
  refreshTokenExpiresAt: '2026-10-03T13:00:00.000Z',
  obtainedAt: '2026-10-03T12:00:00.000Z',
};

describe('readTokenFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-token-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileWith(text: string): string {
    const path = join(dir, 'sim.json');
    writeFileSync(path, text);
    return path;
  }

  it('returns undefined when no file exists', () => {
    expect(readTokenFile(join(dir, 'absent.json'))).toBeUndefined();
  });

  it('reads a saved session', () => {
    expect(readTokenFile(fileWith(JSON.stringify(RECORD)))).toEqual(RECORD);
  });

  it('names the error code when the file cannot be read', () => {
    expect(() => readTokenFile(dir)).toThrow(
      `Saxo token file at ${dir} could not be read (EISDIR).`,
    );
  });

  it('says "unknown error" when the read fails without a code', () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw 'no code';
    });
    const path = join(dir, 'sim.json');
    expect(() => readTokenFile(path)).toThrow(
      `Saxo token file at ${path} could not be read (unknown error).`,
    );
  });

  it('rejects a file that is not JSON', () => {
    const path = fileWith('{not json');
    expect(() => readTokenFile(path)).toThrow(`Saxo token file at ${path} is not valid JSON.`);
  });

  it('rejects JSON that is not an object', () => {
    const path = fileWith('"a string"');
    expect(() => readTokenFile(path)).toThrow(`Saxo token file at ${path} is not an object.`);
  });

  it('rejects JSON null', () => {
    const path = fileWith('null');
    expect(() => readTokenFile(path)).toThrow(`Saxo token file at ${path} is not an object.`);
  });

  it('rejects an unknown environment', () => {
    const path = fileWith(JSON.stringify({ ...RECORD, environment: 'prod' }));
    expect(() => readTokenFile(path)).toThrow(
      `Saxo token file at ${path} names no known environment.`,
    );
  });
});
