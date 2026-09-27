import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandRunner, LITESTREAM_VERSION } from './backup.js';
import { main } from './backup-cli.js';

const ENV = {
  R2_ACCESS_KEY_ID: 'a',
  R2_SECRET_ACCESS_KEY: 'b',
  R2_ENDPOINT: 'https://c',
  R2_BUCKET: 'd',
  LITESTREAM_SSE_C_KEY: 'e',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder() {
  const commands: string[] = [];
  const run: CommandRunner = (_bin, args) => {
    commands.push(args[0] ?? '');
    return Promise.resolve({ code: 0, output: args[0] === 'version' ? LITESTREAM_VERSION : '' });
  };
  return { run, commands };
}

const quiet = { log: () => {} };

function researchStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'backup-cli-'));
  dirs.push(dir);
  const path = join(dir, 'research.sqlite');
  writeFileSync(path, '');
  return path;
}

describe('backup CLI', () => {
  it('refuses an unknown command with its usage', async () => {
    const { run, commands } = recorder();
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['sync'], ENV, run, quiet)).toBe(1);
      expect(await main([], ENV, run, quiet)).toBe(1);
      expect(written.mock.calls.map(([text]) => text)).toEqual([
        'usage: backup-cli backup | restore\n',
        'usage: backup-cli backup | restore\n',
      ]);
    } finally {
      written.mockRestore();
    }
    expect(commands).toEqual([]);
  });

  it('logs to stderr as JSON by default', async () => {
    const { run } = recorder();
    const env = { ...ENV, SAMURAI_RESEARCH_STORE: researchStore() };
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await main(['backup'], env, run);
      const [line] = written.mock.calls.map(([text]) => String(text));
      expect(JSON.parse(line ?? '')).toMatchObject({ event: 'v2_backup_replicated' });
      expect(line?.endsWith('\n')).toBe(true);
    } finally {
      written.mockRestore();
    }
  });

  it('replicates the stores on backup', async () => {
    const { run, commands } = recorder();
    const env = { ...ENV, SAMURAI_RESEARCH_STORE: researchStore() };
    expect(await main(['backup'], env, run, quiet)).toBe(0);
    expect(commands).toEqual(['version', 'replicate']);
  });

  it('restores each missing store on restore', async () => {
    const { run, commands } = recorder();
    const env = { ...ENV, SAMURAI_RESEARCH_STORE: researchStore() };
    expect(await main(['restore'], env, run, quiet)).toBe(0);
    expect(commands).toEqual(['version', 'restore']);
  });

  it('refuses without the backup variables', async () => {
    await expect(main(['backup'], {}, recorder().run, quiet)).rejects.toThrow(
      /refuses without its Litestream backup/,
    );
  });
});
