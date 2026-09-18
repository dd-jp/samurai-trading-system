import {
  type Dirent,
  fstatSync,
  readdirSync,
  rmSync,
  type Stats,
  statSync,
  truncateSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { nonEmpty, positiveIntegerFromEnv } from '../../shared/index.js';
import type { Logger } from './types.js';

export const DEFAULT_LOG_RETENTION_DAYS = 30;

export const DEFAULT_BARE_TRUNCATE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_BARE_TRUNCATE_NAMES: readonly string[] = ['soak-boot.out'];

const STAT_BLOCK_BYTES = 512;

const ENV_LOG_RETENTION_DAYS = 'SAMURAI_LOG_RETENTION_DAYS';
const ENV_LOG_RETENTION_KEEP = 'SAMURAI_LOG_RETENTION_KEEP';
const ENV_LOG_BARE_TRUNCATE_BYTES = 'SAMURAI_LOG_BARE_TRUNCATE_BYTES';
const ENV_LOG_BARE_TRUNCATE_NAMES = 'SAMURAI_LOG_BARE_TRUNCATE_NAMES';

const ROTATED_GENERATION = /^.+\.log\.\d+$/;

const DATESTAMPED_ARTEFACT = /^.*-\d{8}(?:[-.].*)?\.(?:log|out)$/;

export function isArchivedLogName(name: string): boolean {
  return ROTATED_GENERATION.test(name) || DATESTAMPED_ARTEFACT.test(name);
}

const LOG_SHAPED_NAME = /\.(?:log|out)$/;

export function isBareLogName(name: string): boolean {
  return LOG_SHAPED_NAME.test(name) && !isArchivedLogName(name);
}

export function logRetentionDaysFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(
    env[ENV_LOG_RETENTION_DAYS],
    ENV_LOG_RETENTION_DAYS,
    DEFAULT_LOG_RETENTION_DAYS,
    1,
    "the logs/ retention sweep's window (#1116)",
  );
}

export function logBareTruncateBytesFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(
    env[ENV_LOG_BARE_TRUNCATE_BYTES],
    ENV_LOG_BARE_TRUNCATE_BYTES,
    DEFAULT_BARE_TRUNCATE_BYTES,
    1,
    'the size threshold past which an undated, allowlisted bare log file is truncated (#1206)',
  );
}

export function logBareTruncateNamesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = nonEmpty(env[ENV_LOG_BARE_TRUNCATE_NAMES]);
  if (raw === undefined) return DEFAULT_BARE_TRUNCATE_NAMES;

  const names: string[] = [...DEFAULT_BARE_TRUNCATE_NAMES];
  for (const segment of raw.split(',')) {
    const name = segment.trim();
    if (name === '') {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_BARE_TRUNCATE_NAMES} contains an empty entry (a ` +
          'stray or trailing comma). It extends which bare log-shaped names the truncate path ' +
          '(#1206) may reach, beyond the built-in soak-boot.out, so an entry nobody meant is ' +
          'refused rather than ignored.',
      );
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_BARE_TRUNCATE_NAMES} contains ` +
          `${JSON.stringify(name)}, which is a path. The truncate path (#1206) never leaves the ` +
          'one directory it sweeps, so entries are basenames within it.',
      );
    }
    names.push(name);
  }
  return names;
}

export function logRetentionKeepNamesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = nonEmpty(env[ENV_LOG_RETENTION_KEEP]);
  if (raw === undefined) return [];

  const names: string[] = [];
  for (const segment of raw.split(',')) {
    const name = segment.trim();
    if (name === '') {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_RETENTION_KEEP} contains an empty entry (a stray ` +
          'or trailing comma). It names files in logs/ that the retention sweep (#1116) must ' +
          'never delete, so an entry nobody meant is refused rather than ignored.',
      );
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_RETENTION_KEEP} contains ${JSON.stringify(name)}, ` +
          'which is a path. The retention sweep (#1116) never leaves the one directory it ' +
          'sweeps, so entries are basenames within it.',
      );
    }
    names.push(name);
  }
  return names;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface LogRetentionOptions {
  directory: string;
  maxAgeMs: number;
  protectedPaths?: readonly string[];
  keepNames?: readonly string[];
  bareTruncateBytes?: number;
  bareTruncateNames?: readonly string[];
  now?: () => number;
  cwd?: () => string;
  activeDescriptors?: () => readonly FileIdentity[];
  remove?: (path: string) => void;
  truncate?: (path: string) => void;
}

export interface LogRetentionResult {
  filesRemoved: number;
  bytesReclaimed: number;
  filesTruncated: number;
  refusedReason?: string;
}

function defaultActiveDescriptors(): readonly FileIdentity[] {
  const identities: FileIdentity[] = [];
  for (const fd of [1, 2]) {
    try {
      const stat = fstatSync(fd);
      identities.push({ dev: stat.dev, ino: stat.ino });
    } catch {
    }
  }
  return identities;
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function tryRemoveArchivedLogEntry(
  path: string,
  stat: Stats,
  liveIdentities: readonly FileIdentity[],
  cutoff: number,
  remove: (path: string) => void,
): { removed: boolean; bytesReclaimed: number } {
  if (liveIdentities.some((id) => id.dev === stat.dev && id.ino === stat.ino)) {
    return { removed: false, bytesReclaimed: 0 };
  }
  if (stat.mtimeMs >= cutoff) {
    return { removed: false, bytesReclaimed: 0 };
  }
  try {
    remove(path);
  } catch {
    return { removed: false, bytesReclaimed: 0 };
  }
  return { removed: true, bytesReclaimed: stat.size };
}

function isBareTruncateCandidateName(name: string, truncateNameSet: ReadonlySet<string>): boolean {
  return isBareLogName(name) && truncateNameSet.has(name);
}

function tryTruncateBareLogEntry(
  path: string,
  stat: Stats,
  bareTruncateBytes: number,
  truncate: (path: string) => void,
): { truncated: boolean; bytesReclaimed: number } {
  const allocatedBytes = stat.blocks * STAT_BLOCK_BYTES;
  if (allocatedBytes <= bareTruncateBytes) {
    return { truncated: false, bytesReclaimed: 0 };
  }
  try {
    truncate(path);
  } catch {
    return { truncated: false, bytesReclaimed: 0 };
  }
  return { truncated: true, bytesReclaimed: allocatedBytes };
}

interface ResolvedSweepOptions {
  directory: string;
  maxAgeMs: number;
  bareTruncateBytes: number | undefined;
  protectedPaths: readonly string[];
  keepNames: readonly string[];
  bareTruncateNames: readonly string[];
  now: () => number;
  cwd: () => string;
  activeDescriptors: () => readonly FileIdentity[];
  remove: (path: string) => void;
  truncate: (path: string) => void;
}

function resolveSweepOptions(options: LogRetentionOptions): ResolvedSweepOptions {
  const {
    directory,
    maxAgeMs,
    protectedPaths = [],
    keepNames = [],
    bareTruncateBytes,
    bareTruncateNames = [],
    now = Date.now,
    cwd = process.cwd,
    activeDescriptors = defaultActiveDescriptors,
    remove = (path: string) => rmSync(path),
    truncate = (path: string) => truncateSync(path, 0),
  } = options;
  return {
    directory,
    maxAgeMs,
    bareTruncateBytes,
    protectedPaths,
    keepNames,
    bareTruncateNames,
    now,
    cwd,
    activeDescriptors,
    remove,
    truncate,
  };
}

function sweepOneEntry(
  entry: Dirent,
  result: LogRetentionResult,
  ctx: {
    root: string;
    keepSet: ReadonlySet<string>;
    protectedSet: ReadonlySet<string>;
    truncateNameSet: ReadonlySet<string>;
    bareTruncateBytes: number | undefined;
    liveIdentities: readonly FileIdentity[];
    cutoff: number;
    remove: (path: string) => void;
    truncate: (path: string) => void;
  },
): void {
  if (!entry.isFile()) return;
  if (ctx.keepSet.has(entry.name)) return;

  const path = join(ctx.root, entry.name);
  if (ctx.protectedSet.has(resolve(path))) return;

  if (isArchivedLogName(entry.name)) {
    const stat = safeStat(path);
    if (stat === undefined) return;
    const outcome = tryRemoveArchivedLogEntry(
      path,
      stat,
      ctx.liveIdentities,
      ctx.cutoff,
      ctx.remove,
    );
    if (outcome.removed) {
      result.filesRemoved += 1;
      result.bytesReclaimed += outcome.bytesReclaimed;
    }
    return;
  }

  if (
    ctx.bareTruncateBytes === undefined ||
    !isBareTruncateCandidateName(entry.name, ctx.truncateNameSet)
  ) {
    return;
  }

  const stat = safeStat(path);
  if (stat === undefined) return;
  const outcome = tryTruncateBareLogEntry(path, stat, ctx.bareTruncateBytes, ctx.truncate);
  if (outcome.truncated) {
    result.filesTruncated += 1;
    result.bytesReclaimed += outcome.bytesReclaimed;
  }
}

export function sweepStaleLogs(options: LogRetentionOptions): LogRetentionResult {
  const {
    directory,
    maxAgeMs,
    protectedPaths,
    keepNames,
    bareTruncateBytes,
    bareTruncateNames,
    now,
    cwd,
    activeDescriptors,
    remove,
    truncate,
  } = resolveSweepOptions(options);

  const result: LogRetentionResult = { filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 };
  const root = resolve(directory);
  if (root === resolve(cwd())) {
    return {
      ...result,
      refusedReason:
        `${root} is this process's working directory, not a dedicated log directory — ` +
        'a SAMURAI_LOG_FILE with no directory component resolves here, and here is where ' +
        '.env.local lives',
    };
  }
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  const keepSet = new Set(keepNames);
  const truncateNameSet = new Set(bareTruncateNames);
  const liveIdentities = activeDescriptors();
  const cutoff = now() - maxAgeMs;

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  const ctx = {
    root,
    keepSet,
    protectedSet,
    truncateNameSet,
    bareTruncateBytes,
    liveIdentities,
    cutoff,
    remove,
    truncate,
  };
  for (const entry of entries) {
    sweepOneEntry(entry, result, ctx);
  }

  return result;
}

export function sweepStaleLogsWithLog(
  options: LogRetentionOptions,
  logger: Logger,
): LogRetentionResult {
  try {
    const result = sweepStaleLogs(options);
    if (result.refusedReason !== undefined) {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        event: 'log_retention_refused',
        level: 'warn',
        message: `logs/ retention sweep refused to sweep ${options.directory} — growth there is unbounded until SAMURAI_LOG_FILE names a dedicated log directory`,
        payload: { directory: options.directory, reason: result.refusedReason },
      });
      return result;
    }
    if (result.filesRemoved > 0 || result.filesTruncated > 0) {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        level: 'info',
        message: `logs/ retention sweep removed ${result.filesRemoved} stale file(s) and truncated ${result.filesTruncated} bare file(s)`,
        payload: {
          files_removed: result.filesRemoved,
          files_truncated: result.filesTruncated,
          bytes_reclaimed: result.bytesReclaimed,
        },
      });
    }
    return result;
  } catch (error) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'log_retention_failed',
      level: 'warn',
      message:
        'logs/ retention sweep failed — logging continues, but growth in logs/ is unbounded ' +
        'until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return { filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 };
  }
}
