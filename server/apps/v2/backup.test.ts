import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../../shared/index.js';
import {
  type BackupTarget,
  backupFor,
  backupTargets,
  type CommandRunner,
  execRunner,
  LITESTREAM_VERSION,
  litestreamConfig,
  litestreamFor,
  missingBackupEnv,
  NO_BACKUP,
  replicateOnce,
  restoreMissing,
  scrubbed,
  thenBackup,
} from './backup.js';

const ENV = {
  R2_ACCESS_KEY_ID: 'AKIDSECRETVALUE',
  R2_SECRET_ACCESS_KEY: 'SUPERSECRETACCESS',
  R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
  R2_BUCKET: 'bucket-x',
  LITESTREAM_SSE_C_KEY: 'c3NlLWMta2V5LXZhbHVl',
};

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly bin: string;
  readonly args: readonly string[];
  readonly config?: string;
  readonly configMode?: number;
}

function fakeRunner(answers: Record<string, { code: number; output: string }> = {}) {
  const calls: Call[] = [];
  const configs: string[] = [];
  const run: CommandRunner = (bin, args) => {
    const at = args.indexOf('-config');
    const configPath = at === -1 ? undefined : args[at + 1];
    if (configPath !== undefined) configs.push(configPath);
    calls.push({
      bin,
      args,
      config: configPath === undefined ? undefined : readFileSync(configPath, 'utf8'),
      configMode: configPath === undefined ? undefined : statSync(configPath).mode & 0o777,
    });
    const [command = ''] = args;
    return Promise.resolve(
      answers[command] ?? {
        code: 0,
        output: command === 'version' ? `${LITESTREAM_VERSION}\n` : '',
      },
    );
  };
  return { run, calls, configs };
}

function silent() {
  const entries: LogEntry[] = [];
  return { entries, logger: { log: (entry: LogEntry) => entries.push(entry) } };
}

function storesIn(dir: string, present: readonly string[]): BackupTarget[] {
  for (const name of present) writeFileSync(join(dir, name), '');
  return [
    { dbPath: join(dir, 'paper.sqlite'), replicaPath: 'v2/paper' },
    { dbPath: join(dir, 'research.sqlite'), replicaPath: 'v2/research' },
  ];
}

describe('backup configuration', () => {
  it('names every blank or missing backup variable', () => {
    expect(missingBackupEnv({ ...ENV, R2_BUCKET: '  ', LITESTREAM_SSE_C_KEY: undefined })).toEqual([
      'R2_BUCKET',
      'LITESTREAM_SSE_C_KEY',
    ]);
    expect(missingBackupEnv(ENV)).toEqual([]);
  });

  it('writes one encrypted replica per store, by variable reference only', () => {
    const config = litestreamConfig([
      { dbPath: '/a/paper.sqlite', replicaPath: 'v2/paper' },
      { dbPath: '/b/research.sqlite', replicaPath: 'v2/research' },
    ]);
    const replica = (path: string) => [
      '    replica:',
      '      type: s3',
      '      bucket: $' + '{R2_BUCKET}',
      `      path: ${path}`,
      '      endpoint: $' + '{R2_ENDPOINT}',
      '      region: auto',
      '      access-key-id: $' + '{R2_ACCESS_KEY_ID}',
      '      secret-access-key: $' + '{R2_SECRET_ACCESS_KEY}',
      '      sse-customer-key: $' + '{LITESTREAM_SSE_C_KEY}',
    ];
    expect(config.split('\n')).toEqual([
      'dbs:',
      '  - path: "/a/paper.sqlite"',
      ...replica('v2/paper'),
      '  - path: "/b/research.sqlite"',
      ...replica('v2/research'),
      '',
    ]);
  });

  it('puts both replicas under LITESTREAM_REPLICA_ROOT when it is set', () => {
    expect(
      backupTargets('p.sqlite', {
        LITESTREAM_REPLICA_ROOT: 'drill/x',
        SAMURAI_RESEARCH_STORE: 'r.sqlite',
      }).map((target) => target.replicaPath),
    ).toEqual(['drill/x/paper', 'drill/x/research']);
    expect(
      backupTargets('p.sqlite', { LITESTREAM_REPLICA_ROOT: ' ' }).map(
        (target) => target.replicaPath,
      ),
    ).toEqual(['v2/paper', 'v2/research']);
  });

  it('backs up the paper store and the research store at absolute paths', () => {
    expect(
      backupTargets('data/paper.sqlite', { SAMURAI_RESEARCH_STORE: 'r/research.sqlite' }),
    ).toEqual([
      { dbPath: resolve('data/paper.sqlite'), replicaPath: 'v2/paper' },
      { dbPath: resolve('r/research.sqlite'), replicaPath: 'v2/research' },
    ]);
  });

  it('replaces every backup secret and the endpoint in text it passes on', () => {
    const text = `PUT ${ENV.R2_ENDPOINT}/${ENV.R2_BUCKET} key=${ENV.R2_ACCESS_KEY_ID} sse ${ENV.LITESTREAM_SSE_C_KEY} ${ENV.R2_SECRET_ACCESS_KEY}`;
    expect(scrubbed(text, ENV)).toBe(
      'PUT [R2_ENDPOINT]/[R2_BUCKET] key=[R2_ACCESS_KEY_ID] sse [LITESTREAM_SSE_C_KEY] [R2_SECRET_ACCESS_KEY]',
    );
    expect(scrubbed('token=abc', {})).toBe('[REDACTED]');
  });

  it('refuses a paper run without its backup variables, naming them and nothing else', () => {
    expect(() => litestreamFor({ R2_BUCKET: 'bucket-x' }, fakeRunner().run)).toThrow(
      'paper run refuses without its Litestream backup: set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, LITESTREAM_SSE_C_KEY',
    );
  });

  it('runs litestream from PATH unless LITESTREAM_BIN names it', () => {
    const { run } = fakeRunner();
    expect(litestreamFor(ENV, run).bin).toBe('litestream');
    expect(litestreamFor({ ...ENV, LITESTREAM_BIN: '/opt/ls' }, run).bin).toBe('/opt/ls');
  });
});

describe('replicateOnce', () => {
  it('checks the pinned version, then replicates the stores that exist through a private config it deletes', async () => {
    const fake = fakeRunner();
    const { entries, logger } = silent();
    const targets = storesIn(scratch(), ['paper.sqlite']);
    await replicateOnce(litestreamFor(ENV, fake.run), targets, logger);
    expect(fake.calls.map((call) => call.args[0])).toEqual(['version', 'replicate']);
    const [, replicate] = fake.calls;
    expect(replicate?.args).toEqual(['replicate', '-once', '-config', fake.configs[0]]);
    expect(replicate?.configMode).toBe(0o600);
    expect(replicate?.config).toBe(litestreamConfig([targets[0] as BackupTarget]));
    expect(existsSync(fake.configs[0] as string)).toBe(false);
    expect(entries.map((entry) => [entry.level, entry.event, entry.message])).toEqual([
      ['info', 'v2_backup_replicated', 'replicated v2/paper'],
    ]);
  });

  it('does nothing when no store exists yet', async () => {
    const fake = fakeRunner();
    const { entries, logger } = silent();
    await replicateOnce(litestreamFor(ENV, fake.run), storesIn(scratch(), []), logger);
    expect([fake.calls, entries]).toEqual([[], []]);
  });

  it('refuses a litestream other than the pinned version', async () => {
    const fake = fakeRunner({ version: { code: 0, output: '0.3.13\n' } });
    await expect(
      replicateOnce(
        litestreamFor(ENV, fake.run),
        storesIn(scratch(), ['paper.sqlite']),
        silent().logger,
      ),
    ).rejects.toThrow(`litestream 0.3.13 found, ${LITESTREAM_VERSION} is pinned`);
    expect(fake.calls).toHaveLength(1);
  });

  it('fails with the exit code and scrubbed output, and still deletes the config', async () => {
    const fake = fakeRunner({
      replicate: { code: 2, output: `PutObject ${ENV.R2_ENDPOINT}: AccessDenied` },
    });
    await expect(
      replicateOnce(
        litestreamFor(ENV, fake.run),
        storesIn(scratch(), ['paper.sqlite', 'research.sqlite']),
        silent().logger,
      ),
    ).rejects.toThrow('litestream replicate failed (2): PutObject [R2_ENDPOINT]: AccessDenied');
    expect(existsSync(fake.configs[0] as string)).toBe(false);
  });

  it('reports a failed version probe as its own failure', async () => {
    const fake = fakeRunner({ version: { code: 127, output: 'not found' } });
    await expect(
      replicateOnce(
        litestreamFor(ENV, fake.run),
        storesIn(scratch(), ['paper.sqlite']),
        silent().logger,
      ),
    ).rejects.toThrow('litestream version failed (127): not found');
  });
});

describe('restoreMissing', () => {
  it('restores each store only where it is missing and a replica exists', async () => {
    const fake = fakeRunner();
    const targets = storesIn(scratch(), []);
    await restoreMissing(litestreamFor(ENV, fake.run), targets);
    expect(fake.calls.map((call) => call.args)).toEqual([
      ['version'],
      ...targets.map((target) => [
        'restore',
        '-config',
        fake.configs[0],
        '-if-db-not-exists',
        '-if-replica-exists',
        target.dbPath,
      ]),
    ]);
    expect(fake.calls[1]?.config).toBe(litestreamConfig(targets));
  });

  it('names the replica whose restore failed', async () => {
    const fake = fakeRunner({ restore: { code: 1, output: 'InvalidRequest' } });
    await expect(
      restoreMissing(litestreamFor(ENV, fake.run), storesIn(scratch(), [])),
    ).rejects.toThrow('litestream restore of v2/paper failed (1): InvalidRequest');
  });
});

describe('backupFor', () => {
  it('never backs up a dry run and needs no backup variables for one', () => {
    expect(backupFor(['--dry-run'], 'x.sqlite', {}, fakeRunner().run, silent().logger)).toBe(
      NO_BACKUP,
    );
  });

  it('checks the variables before the cycle and replicates the paper store after it', async () => {
    expect(() => backupFor([], 'x.sqlite', {}, fakeRunner().run, silent().logger)).toThrow(
      /paper run refuses without its Litestream backup/,
    );
    const dir = scratch();
    writeFileSync(join(dir, 'paper.sqlite'), '');
    const fake = fakeRunner();
    const backup = backupFor(
      ['--date', '2026-09-28'],
      join(dir, 'paper.sqlite'),
      { ...ENV, SAMURAI_RESEARCH_STORE: join(dir, 'research.sqlite') },
      fake.run,
      silent().logger,
    );
    expect(fake.calls).toEqual([]);
    await backup();
    expect(fake.calls[1]?.config).toContain(`path: ${JSON.stringify(join(dir, 'paper.sqlite'))}`);
    expect(fake.calls[1]?.config).not.toContain('research.sqlite');
  });

  it('resolves the no-op backup', async () => {
    await expect(NO_BACKUP()).resolves.toBeUndefined();
  });
});

describe('thenBackup', () => {
  it('backs up after the cycle and returns its exit code', async () => {
    const order: string[] = [];
    const code = await thenBackup(
      async () => {
        order.push('cycle');
        return 1;
      },
      async () => {
        order.push('backup');
      },
    );
    expect([code, order]).toEqual([1, ['cycle', 'backup']]);
  });

  it('skips the backup when the cycle throws, and fails when the backup does', async () => {
    let backedUp = false;
    await expect(
      thenBackup(
        () => Promise.reject(new Error('cycle')),
        async () => {
          backedUp = true;
        },
      ),
    ).rejects.toThrow('cycle');
    expect(backedUp).toBe(false);
    await expect(
      thenBackup(
        () => Promise.resolve(0),
        () => Promise.reject(new Error('backup')),
      ),
    ).rejects.toThrow('backup');
  });
});

describe('execRunner', () => {
  it('returns stdout and stderr with the exit code', async () => {
    const script = "process.stdout.write('out');process.stderr.write('err');process.exit(3)";
    await expect(execRunner(process.execPath, ['-e', script], process.env)).resolves.toEqual({
      code: 3,
      output: 'outerr',
    });
    await expect(
      execRunner(process.execPath, ['-e', "process.stdout.write('ok')"], process.env),
    ).resolves.toEqual({
      code: 0,
      output: 'ok',
    });
  });

  it('reports a binary that cannot start as exit 1', async () => {
    const result = await execRunner(join(scratch(), 'missing-bin'), [], process.env);
    expect(result.code).toBe(1);
  });

  it('passes the environment it is given', async () => {
    await expect(
      execRunner(process.execPath, ['-e', 'process.stdout.write(process.env.ONLY_HERE ?? "")'], {
        ONLY_HERE: 'yes',
      }),
    ).resolves.toEqual({ code: 0, output: 'yes' });
  });
});
