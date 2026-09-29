import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearKeepAliveState,
  keepAliveStatePath,
  readKeepAliveState,
  writeKeepAliveState,
} from './saxo-keepalive-state.js';

describe('Saxo keep-alive state file', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-keepalive-state-'));
    tokenPath = join(dir, 'live.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sits beside the token file', () => {
    expect(keepAliveStatePath(tokenPath)).toBe(`${tokenPath}.keepalive.json`);
  });

  it('reads as empty when absent', () => {
    expect(readKeepAliveState(tokenPath)).toEqual({});
  });

  it('round-trips every field at 0600 and leaves no temp file', () => {
    const state = { lostAt: '2026-09-29T10:00:00.000Z', lostReason: 'rejected', warnedAt: 'w' };
    writeKeepAliveState(tokenPath, state);

    expect(readKeepAliveState(tokenPath)).toEqual(state);
    expect(statSync(keepAliveStatePath(tokenPath)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${keepAliveStatePath(tokenPath)}.tmp-${process.pid}`)).toBe(false);
  });

  it('round-trips a partial state without inventing fields', () => {
    writeKeepAliveState(tokenPath, { warnedAt: 'w' });
    expect(readKeepAliveState(tokenPath)).toStrictEqual({ warnedAt: 'w' });
    writeKeepAliveState(tokenPath, { lostAt: 'l' });
    expect(readKeepAliveState(tokenPath)).toStrictEqual({ lostAt: 'l' });
    writeKeepAliveState(tokenPath, { lostReason: 'r' });
    expect(readKeepAliveState(tokenPath)).toStrictEqual({ lostReason: 'r' });
  });

  it.each([['not json'], ['null'], ['[1]'], ['{"lostAt":5}']])(
    'reads %s as an empty state',
    (text) => {
      writeFileSync(keepAliveStatePath(tokenPath), text);
      expect(readKeepAliveState(tokenPath)).toEqual({});
    },
  );

  it('clear removes the file and tolerates its absence', () => {
    writeKeepAliveState(tokenPath, { warnedAt: 'w' });
    clearKeepAliveState(tokenPath);
    clearKeepAliveState(tokenPath);
    expect(existsSync(keepAliveStatePath(tokenPath))).toBe(false);
  });
});
