import { type ExecFileException, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Logger, maskCredentials } from '../../shared/index.js';
import { researchStorePath } from './trial-ledger.js';

export const LITESTREAM_VERSION = '0.5.17';

const BACKUP_ENV = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'LITESTREAM_SSE_C_KEY',
] as const;

const PASSED_ENV = ['PATH', 'HOME', ...BACKUP_ENV];

const REPLICA_ROOT = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export interface BackupTarget {
  readonly dbPath: string;
  readonly replicaPath: string;
}

export interface CommandResult {
  readonly code: number;
  readonly output: string;
}

export type CommandRunner = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface Backup {
  readonly restore: () => Promise<void>;
  readonly replicate: () => Promise<void>;
}

export const NO_BACKUP: Backup = {
  restore: () => Promise.resolve(),
  replicate: () => Promise.resolve(),
};

function failureReason(error: ExecFileException): string {
  return typeof error.code === 'string' ? error.code : (error.signal ?? '');
}

function resultOf(error: ExecFileException | null, output: string): CommandResult {
  if (error === null) return { code: 0, output };
  const reason = failureReason(error);
  return {
    code: typeof error.code === 'number' ? error.code : 1,
    output: reason === '' ? output : `${output}\n${reason}`,
  };
}

export const execRunner: CommandRunner = (bin, args, env) =>
  new Promise((done) => {
    execFile(bin, [...args], { env, timeout: 300_000 }, (error, stdout, stderr) => {
      done(resultOf(error, `${stdout}${stderr}`));
    });
  });

export function backupTargets(storePath: string, env: NodeJS.ProcessEnv): BackupTarget[] {
  const root = (env.LITESTREAM_REPLICA_ROOT?.trim() || 'v2').replace(/\/+$/, '');
  if (!REPLICA_ROOT.test(root)) {
    throw new Error('LITESTREAM_REPLICA_ROOT may hold only letters, digits, _, - and /');
  }
  const targets = [
    { dbPath: resolve(storePath), replicaPath: `${root}/paper` },
    { dbPath: resolve(researchStorePath(env)), replicaPath: `${root}/research` },
  ];
  const expanded = targets.find((target) => target.dbPath.includes('$'));
  if (expanded !== undefined) {
    throw new Error(`Litestream would expand the $ in ${expanded.dbPath}`);
  }
  return targets;
}

export function missingBackupEnv(env: NodeJS.ProcessEnv): string[] {
  return BACKUP_ENV.filter((name) => (env[name] ?? '').trim() === '');
}

const ref = (name: (typeof BACKUP_ENV)[number]) => `\${${name}}`;

export function litestreamConfig(targets: readonly BackupTarget[]): string {
  const entries = targets.map((target) =>
    [
      `  - path: ${JSON.stringify(target.dbPath)}`,
      '    replica:',
      '      type: s3',
      `      bucket: ${ref('R2_BUCKET')}`,
      `      path: ${JSON.stringify(target.replicaPath)}`,
      `      endpoint: ${ref('R2_ENDPOINT')}`,
      '      region: auto',
      `      access-key-id: ${ref('R2_ACCESS_KEY_ID')}`,
      `      secret-access-key: ${ref('R2_SECRET_ACCESS_KEY')}`,
      `      sse-customer-key: ${ref('LITESTREAM_SSE_C_KEY')}`,
    ].join('\n'),
  );
  return `dbs:\n${entries.join('\n')}\n`;
}

function endpointParts(endpoint: string): string[] {
  try {
    const { host } = new URL(endpoint);
    return [host, host.split('.')[0] ?? host];
  } catch {
    return [];
  }
}

function secretsIn(env: NodeJS.ProcessEnv): [string, string][] {
  const pairs: [string, string][] = [];
  for (const name of BACKUP_ENV) {
    const value = env[name]?.trim().replace(/\/+$/, '');
    if (value) pairs.push([name, value]);
  }
  for (const part of endpointParts(env.R2_ENDPOINT ?? '')) pairs.push(['R2_ENDPOINT', part]);
  return pairs.sort(([, a], [, b]) => b.length - a.length);
}

export function scrubbed(text: string, env: NodeJS.ProcessEnv): string {
  let clean = text;
  for (const [name, value] of secretsIn(env)) clean = clean.split(value).join(`[${name}]`);
  return maskCredentials(clean);
}

export interface Litestream {
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run: CommandRunner;
}

async function litestream(tool: Litestream, args: readonly string[], what: string) {
  const result = await tool.run(tool.bin, args, tool.env);
  if (result.code !== 0) {
    throw new Error(
      `litestream ${what} failed (${result.code}): ${scrubbed(result.output, tool.env)}`,
    );
  }
  return result.output;
}

async function withConfig<T>(
  tool: Litestream,
  targets: readonly BackupTarget[],
  use: (configPath: string) => Promise<T>,
): Promise<T> {
  const version = (await litestream(tool, ['version'], 'version')).trim();
  if (version !== LITESTREAM_VERSION) {
    throw new Error(
      `litestream ${scrubbed(version, tool.env).slice(0, 80)} found, ${LITESTREAM_VERSION} is pinned`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'samurai-litestream-'));
  const configPath = join(dir, 'litestream.yml');
  writeFileSync(configPath, litestreamConfig(targets), { mode: 0o600 });
  try {
    return await use(configPath);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

export function litestreamFor(env: NodeJS.ProcessEnv, run: CommandRunner): Litestream {
  const missing = missingBackupEnv(env);
  if (missing.length > 0) {
    throw new Error(`paper run refuses without its Litestream backup: set ${missing.join(', ')}`);
  }
  const passed = Object.fromEntries(
    PASSED_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
  return { bin: env.LITESTREAM_BIN ?? 'litestream', env: passed, run };
}

function logBackup(logger: Logger, event: string, message: string): void {
  logger.log({ trace_id: 'v2-backup', stage: 'v2', level: 'info', event, message });
}

export async function replicateOnce(
  tool: Litestream,
  targets: readonly BackupTarget[],
  logger: Logger,
): Promise<void> {
  const present = targets.filter((target) => existsSync(target.dbPath));
  if (present.length === 0) return;
  await withConfig(tool, present, (configPath) =>
    litestream(tool, ['replicate', '-once', '-config', configPath], 'replicate'),
  );
  logBackup(
    logger,
    'v2_backup_replicated',
    `replicated ${present.map((target) => target.replicaPath).join(', ')}`,
  );
}

async function restoreOne(
  tool: Litestream,
  configPath: string,
  target: BackupTarget,
  logger: Logger,
): Promise<void> {
  await litestream(
    tool,
    ['restore', '-config', configPath, '-if-db-not-exists', '-if-replica-exists', target.dbPath],
    `restore of ${target.replicaPath}`,
  );
  if (existsSync(target.dbPath)) {
    logBackup(logger, 'v2_backup_restored', `${target.replicaPath}: restored`);
  } else {
    logBackup(logger, 'v2_backup_no_replica', `${target.replicaPath}: no replica to restore`);
  }
}

export async function restoreMissing(
  tool: Litestream,
  targets: readonly BackupTarget[],
  logger: Logger,
): Promise<void> {
  const missing = targets.filter((target) => !existsSync(target.dbPath));
  if (missing.length === 0) return;
  await withConfig(tool, missing, async (configPath) => {
    for (const target of missing) await restoreOne(tool, configPath, target, logger);
  });
}

export function backupFor(
  argv: readonly string[],
  storePath: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
  logger: Logger,
): Backup {
  if (argv.includes('--dry-run')) return NO_BACKUP;
  const tool = litestreamFor(env, run);
  const targets = backupTargets(storePath, env);
  return {
    restore: () => restoreMissing(tool, targets, logger),
    replicate: () => replicateOnce(tool, targets, logger),
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function withBackup(run: () => Promise<number>, backup: Backup): Promise<number> {
  await backup.restore();
  let code: number;
  try {
    code = await run();
  } catch (error) {
    await backup.replicate().catch((backupError: unknown) => {
      throw new Error(
        `${messageOf(error)}; the backup after it also failed: ${messageOf(backupError)}`,
        {
          cause: error,
        },
      );
    });
    throw error;
  }
  await backup.replicate();
  return code;
}
