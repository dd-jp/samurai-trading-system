import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTokenFile } from '../../../pipeline/execution/adapters/saxo-token-file.js';
import { saxoTokenSecrets } from './saxo-token-secrets.js';

const tokenFiles = vi.hoisted(() => ({ directory: '' }));

vi.mock('../../../pipeline/execution/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../pipeline/execution/index.js')>();
  return {
    ...actual,
    tokenFilePath: (environment: string) => join(tokenFiles.directory, `${environment}.json`),
  };
});

describe('saxoTokenSecrets', () => {
  beforeEach(() => {
    tokenFiles.directory = mkdtempSync(join(tmpdir(), 'v2-token-secrets-'));
  });

  afterEach(() => {
    rmSync(tokenFiles.directory, { recursive: true, force: true });
  });

  it('names the access and refresh token of each saved session file', () => {
    writeTokenFile(join(tokenFiles.directory, 'live.json'), {
      environment: 'live',
      accessToken: 'fake-live-access-token',
      refreshToken: 'fake-live-refresh-token',
      accessTokenExpiresAt: '2026-09-30T08:20:00.000Z',
      refreshTokenExpiresAt: '2026-09-30T09:00:00.000Z',
      obtainedAt: '2026-09-30T08:00:00.000Z',
    });
    expect(saxoTokenSecrets()).toEqual([
      { name: 'saxo-tokens/live.json accessToken', value: 'fake-live-access-token' },
      { name: 'saxo-tokens/live.json refreshToken', value: 'fake-live-refresh-token' },
    ]);
  });

  it('yields nothing for a missing or unreadable file', () => {
    writeFileSync(join(tokenFiles.directory, 'sim.json'), 'not json');
    expect(saxoTokenSecrets()).toEqual([]);
  });
});
