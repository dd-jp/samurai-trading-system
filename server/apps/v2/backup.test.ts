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
  withBackup,
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
  readonly config: string | undefined;
  readonly configMode: number | undefined;
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
      `      path: "${path}"`,
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

  it('matches a secret without the whitespace around it, and ignores a blank one', () => {
    expect(scrubbed('bucket-x ok', { R2_BUCKET: ' bucket-x\n', R2_ENDPOINT: '' })).toBe(
      '[R2_BUCKET] ok',
    );
  });

  it('strips a trailing slash from the replica root and refuses one that could break the config', () => {
    const paths = (root: string) =>
      backupTargets('p.sqlite', { LITESTREAM_REPLICA_ROOT: root }).map(
        (target) => target.replicaPath,
      );
    expect(paths('drill/x//')).toEqual(['drill/x/paper', 'drill/x/research']);
    for (const root of ['a\n  sse-customer-key: ""', 'a: b', 'a#b', '../up', '/abs']) {
      expect(() => paths(root)).toThrow(
        'LITESTREAM_REPLICA_ROOT may hold only letters, digits, _, - and /',
      );
    }
  });

  it('refuses a store path Litestream would expand', () => {
    expect(() =>
      backupTargets('/tmp/$HOME/p.sqlite', { SAMURAI_RESEARCH_STORE: 'r.sqlite' }),
    ).toThrow('Litestream would expand the $ in /tmp/$HOME/p.sqlite');
    expect(() => backupTargets('p.sqlite', { SAMURAI_RESEARCH_STORE: '/r/$X.sqlite' })).toThrow(
      'Litestream would expand the $ in /r/$X.sqlite',
    );
  });

  it('scrubs the endpoint host and account id when only they are echoed', () => {
    const env = { ...ENV, R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com/' };
    expect(
      scrubbed('lookup acct123.r2.cloudflarestorage.com: no such host; account acct123', env),
    ).toBe('lookup [R2_ENDPOINT]: no such host; account [R2_ENDPOINT]');
    expect(scrubbed('fine', { ...ENV, R2_ENDPOINT: 'not a url' })).toBe('fine');
  });

  it('hands litestream only PATH, HOME and the backup variables', () => {
    const tool = litestreamFor(
      { ...ENV, PATH: '/bin', HOME: '/h', NOUS_API_KEY: 'llm', ALPACA_SECRET: 'broker' },
      fakeRunner().run,
    );
    expect(tool.env).toEqual({ PATH: '/bin', HOME: '/h', ...ENV });
  });

  it('pins the Litestream version the drills ran', () => {
    expect(LITESTREAM_VERSION).toBe('0.5.17');
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
    expect(fake.configs[0]).toContain(join(tmpdir(), 'samurai-litestream-'));
    expect(existsSync(fake.configs[0] as string)).toBe(false);
    expect(entries).toEqual([
      {
        trace_id: 'v2-backup',
        stage: 'v2',
        level: 'info',
        event: 'v2_backup_replicated',
        message: 'replicated v2/paper',
      },
    ]);
  });

  it('names every store it replicated', async () => {
    const { entries, logger } = silent();
    await replicateOnce(
      litestreamFor(ENV, fakeRunner().run),
      storesIn(scratch(), ['paper.sqlite', 'research.sqlite']),
      logger,
    );
    expect(entries.map((entry) => entry.message)).toEqual(['replicated v2/paper, v2/research']);
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

  it('scrubs and caps an unexpected version string', async () => {
    const fake = fakeRunner({
      version: { code: 0, output: `${ENV.R2_ENDPOINT} ${'x'.repeat(200)}` },
    });
    const error = await replicateOnce(
      litestreamFor(ENV, fake.run),
      storesIn(scratch(), ['paper.sqlite']),
      silent().logger,
    ).catch((caught: unknown) => caught as Error);
    expect(error.message).toBe(
      `litestream [R2_ENDPOINT] ${'x'.repeat(66)} found, ${LITESTREAM_VERSION} is pinned`,
    );
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
  it('restores only the missing stores and says which it restored', async () => {
    const dir = scratch();
    const targets = storesIn(dir, ['research.sqlite']);
    const calls: (readonly string[])[] = [];
    const run: CommandRunner = (_bin, args) => {
      calls.push(args);
      if (args[0] === 'restore') writeFileSync(args[args.length - 1] as string, '');
      return Promise.resolve({ code: 0, output: args[0] === 'version' ? LITESTREAM_VERSION : '' });
    };
    const { entries, logger } = silent();
    await restoreMissing(litestreamFor(ENV, run), targets, logger);
    expect(calls.map((args) => args.filter((arg) => !arg.endsWith('litestream.yml')))).toEqual([
      ['version'],
      ['restore', '-config', '-if-db-not-exists', '-if-replica-exists', join(dir, 'paper.sqlite')],
    ]);
    expect(entries).toEqual([
      {
        trace_id: 'v2-backup',
        stage: 'v2',
        level: 'info',
        event: 'v2_backup_restored',
        message: 'v2/paper: restored',
      },
    ]);
  });

  it('says when a missing store has no replica', async () => {
    const fake = fakeRunner();
    const { entries, logger } = silent();
    const targets = storesIn(scratch(), []);
    await restoreMissing(litestreamFor(ENV, fake.run), targets, logger);
    expect(fake.calls[1]?.config).toBe(litestreamConfig(targets));
    expect(entries.map((entry) => [entry.event, entry.message])).toEqual([
      ['v2_backup_no_replica', 'v2/paper: no replica to restore'],
      ['v2_backup_no_replica', 'v2/research: no replica to restore'],
    ]);
  });

  it('never calls litestream when every store is present', async () => {
    const fake = fakeRunner();
    await restoreMissing(
      litestreamFor(ENV, fake.run),
      storesIn(scratch(), ['paper.sqlite', 'research.sqlite']),
      silent().logger,
    );
    expect(fake.calls).toEqual([]);
  });

  it('names the replica whose restore failed', async () => {
    const fake = fakeRunner({ restore: { code: 1, output: 'InvalidRequest' } });
    await expect(
      restoreMissing(litestreamFor(ENV, fake.run), storesIn(scratch(), []), silent().logger),
    ).rejects.toThrow('litestream restore of v2/paper failed (1): InvalidRequest');
  });
});

describe('backupFor', () => {
  it('never backs up a dry run and needs no backup variables for one', () => {
    expect(backupFor(['--dry-run'], 'x.sqlite', {}, fakeRunner().run, silent().logger)).toBe(
      NO_BACKUP,
    );
  });

  it('checks the variables before the cycle, restores a missing store, and replicates', async () => {
    expect(() => backupFor([], 'x.sqlite', {}, fakeRunner().run, silent().logger)).toThrow(
      /paper run refuses without its Litestream backup/,
    );
    const dir = scratch();
    const fake = fakeRunner();
    const backup = backupFor(
      ['--date', '2026-09-28'],
      join(dir, 'paper.sqlite'),
      { ...ENV, SAMURAI_RESEARCH_STORE: join(dir, 'research.sqlite') },
      fake.run,
      silent().logger,
    );
    expect(fake.calls).toEqual([]);
    await backup.restore();
    expect(fake.calls.map((call) => call.args[0])).toEqual(['version', 'restore', 'restore']);
    writeFileSync(join(dir, 'paper.sqlite'), '');
    await backup.replicate();
    expect(fake.calls[4]?.config).toContain(`path: ${JSON.stringify(join(dir, 'paper.sqlite'))}`);
    expect(fake.calls[4]?.config).not.toContain('research.sqlite');
  });

  it('resolves the no-op backup', async () => {
    await expect(NO_BACKUP.restore()).resolves.toBeUndefined();
    await expect(NO_BACKUP.replicate()).resolves.toBeUndefined();
  });
});

function recordingBackup(
  order: string[],
  replicate: () => Promise<void> = () => Promise.resolve(),
) {
  return {
    restore: async () => {
      order.push('restore');
    },
    replicate: async () => {
      order.push('replicate');
      await replicate();
    },
  };
}

describe('withBackup', () => {
  it('restores before the cycle, replicates after it and returns its exit code', async () => {
    const order: string[] = [];
    const code = await withBackup(async () => {
      order.push('cycle');
      return 1;
    }, recordingBackup(order));
    expect([code, order]).toEqual([1, ['restore', 'cycle', 'replicate']]);
  });

  it('still replicates when the cycle throws, then rethrows the cycle error', async () => {
    const order: string[] = [];
    const cycleError = new Error('cycle');
    await expect(withBackup(() => Promise.reject(cycleError), recordingBackup(order))).rejects.toBe(
      cycleError,
    );
    expect(order).toEqual(['restore', 'replicate']);
  });

  it('reports both failures when the cycle and its backup both fail', async () => {
    const failing = recordingBackup([], () => Promise.reject(new Error('R2 down')));
    const error = await withBackup(() => Promise.reject(new Error('cycle')), failing).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toBe('cycle; the backup after it also failed: R2 down');
    expect((error.cause as Error).message).toBe('cycle');
    const plain = await withBackup(
      () => Promise.reject('text'),
      recordingBackup([], () => Promise.reject('down')),
    ).catch((caught: unknown) => caught as Error);
    expect(plain.message).toBe('text; the backup after it also failed: down');
  });

  it('fails when the backup after a clean cycle fails, and never runs the cycle if restore fails', async () => {
    await expect(
      withBackup(
        () => Promise.resolve(0),
        recordingBackup([], () => Promise.reject(new Error('backup'))),
      ),
    ).rejects.toThrow('backup');
    let ran = false;
    await expect(
      withBackup(
        async () => {
          ran = true;
          return 0;
        },
        { restore: () => Promise.reject(new Error('restore')), replicate: () => Promise.resolve() },
      ),
    ).rejects.toThrow('restore');
    expect(ran).toBe(false);
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

  it('reports a binary that cannot start as exit 1 with the reason', async () => {
    await expect(execRunner(join(scratch(), 'missing-bin'), [], process.env)).resolves.toEqual({
      code: 1,
      output: '\nENOENT',
    });
  });

  it('names a signal that killed the process', async () => {
    const result = await execRunner(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      process.env,
    );
    expect(result.output).toBe('\nSIGTERM');
  });

  it('passes the environment it is given', async () => {
    await expect(
      execRunner(process.execPath, ['-e', 'process.stdout.write(process.env.ONLY_HERE ?? "")'], {
        ONLY_HERE: 'yes',
      }),
    ).resolves.toEqual({ code: 0, output: 'yes' });
  });
});
